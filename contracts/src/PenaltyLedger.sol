// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {HumanRegistry} from "./HumanRegistry.sol";
import {IPenaltyMinter} from "./interfaces/IPenalty.sol";

/// @dev ERC-5192 minimal soulbound interface.
interface IERC5192 {
    event Locked(uint256 tokenId);
    event Unlocked(uint256 tokenId);

    function locked(uint256 tokenId) external view returns (bool);
}

/// @notice Optional publisher of scores to a readable namespace (ENSv2 text records).
interface IScorePublisher {
    function publish(address account, uint256 scoreWad, uint64 updatedAt, uint256 ratePerSecWad, uint8 stage)
        external;
}

/// @title PenaltyLedger
/// @notice The verdict token. Minted ONLY when forensics confirms a validation was wrong.
///
///  WHO MINTS   Only MINTER_ROLE, which is granted to the receipts contract. That contract only
///              calls `penalize` after a designated forensics account has ruled on a REAL
///              validation receipt (and due process ended). So: no receipt, no penalty.
///  TO WHOM     The validator's current account, without their consent (`_mint`, not `_safeMint`,
///              so a contract wallet cannot refuse it).
///  TRANSFER    Impossible: transfer, approve, setApprovalForAll and burn revert (ERC-5192).
///  SCORE       Each penalty adds weight to a per-human score:
///                weight = base x (major ? majorMultiplier : 1) + currentScore x escalationBps / 10000
///              so repeat mistakes grow fast (the current score feeds the next weight), and the
///              total is capped at `maxScore` (no overflow, bounded worst case).
///  FADE        The score decays linearly: one minor penalty (weight = base) fades to zero in
///              exactly `fadePeriod` (default 30 days). Bigger stacks take proportionally longer.
///              Each account snapshots its decay rate when updated, so a config change never
///              rewrites past decay retroactively.
///  STAGES      0 = clean
///              1 = score > 0          -> public losing score (published to ENS)
///              2 = score >= stage2At  -> no AI access
///              3 = score >= stage3At  -> banned (no validating, submitting, flagging)
///              Stages lift automatically as the score fades.
///  FORGIVE     EVALUATOR_ROLE may reduce a score to speed recovery. The evaluator must be an
///              enrolled human (so "never your own" compares unique humans), and must give a
///              reason hash. The NFT records stay: history is never deleted.
///  LADDER      Optional, off by default (demo preset): `weightByCount` makes token n weigh
///              base x n (token 1 restricts for one fadePeriod, token 2 for two), and
///              `banAtCount` bans a human permanently once they hold that many tokens: no fade
///              and no forgiveness can undo it.
///  JUDGE       JUDGE_ROLE (demo trust assumption: a server, not an enrolled human) may lift a
///              restriction early with a reason (score -> 0; the token stays). Never a ladder ban.
contract PenaltyLedger is ERC721, AccessControl, IERC5192, IPenaltyMinter {
    using Strings for uint256;

    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE"); //       receipts contract only
    bytes32 public constant EVALUATOR_ROLE = keccak256("EVALUATOR_ROLE"); // may forgive
    bytes32 public constant JUDGE_ROLE = keccak256("JUDGE_ROLE"); //         may lift a restriction (demo)

    uint256 internal constant WAD = 1e18;
    uint256 internal constant BPS = 10_000;

    struct Config {
        uint32 base; //             points for one minor mistake
        uint16 majorMultiplier; //  major mistake = base x this
        uint32 escalationBps; //    share of current score added to each new penalty (10000 = 100%)
        uint32 maxScore; //         hard cap, in points
        uint32 stage2At; //         points: no AI access
        uint32 stage3At; //         points: banned
        uint64 fadePeriod; //       seconds for one `base` to fade to zero
    }

    /// Count-based ladder; all zero = off (score-based behaviour only).
    struct Ladder {
        uint16 banAtCount; //   0 = off; holding this many tokens = banned forever
        bool weightByCount; //  token n weighs base x n instead of the score-based escalation
    }

    struct Account {
        uint128 scoreWad; //  score at `updatedAt`, 18 decimals
        uint64 updatedAt;
        uint128 rateWad; //   decay per second snapshotted at `updatedAt`
    }

    struct Penalty {
        bytes32 human;
        uint256 receiptId;
        bytes32 evidenceHash;
        uint128 weightWad;
        uint64 mintedAt;
        bool major;
    }

    HumanRegistry public immutable humans;
    Config public config;
    Ladder public ladder;
    IScorePublisher public publisher;

    uint256 public nextId = 1;
    mapping(bytes32 human => Account) internal _accounts;
    mapping(uint256 tokenId => Penalty) internal _penalties;
    mapping(uint256 receiptId => uint256 tokenId) public penaltyOfReceipt;
    mapping(bytes32 human => uint16) public penaltyCount;

    event Penalized(
        uint256 indexed tokenId, bytes32 indexed human, uint256 indexed receiptId, uint256 weightWad, uint256 scoreWad, uint8 stage
    );
    event Forgiven(bytes32 indexed human, address indexed evaluator, uint256 amountWad, uint256 scoreWad, bytes32 reasonHash);
    event ConfigSet(Config config);
    event LadderSet(Ladder ladder);
    event PublisherSet(address indexed publisher);
    event PublishFailed(bytes32 indexed human);

    error Soulbound();
    error BadConfig();
    error UnknownHuman();
    error AlreadyPenalized(uint256 receiptId);
    error ReasonRequired();
    error SelfForgiveness();
    error ZeroReceipt();
    error NotEnrolled();
    error BannedForever();

    constructor(HumanRegistry _humans, address admin, Config memory cfg) ERC721("HITL Penalty", "HITLP") {
        humans = _humans;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _setConfig(cfg);
    }

    // ================================================================ score
    /// @notice Current score (18 decimals), after decay.
    function scoreOf(bytes32 human) public view returns (uint256) {
        Account memory a = _accounts[human];
        if (a.scoreWad == 0) return 0;
        uint256 decay = uint256(a.rateWad) * (block.timestamp - a.updatedAt);
        return decay >= a.scoreWad ? 0 : a.scoreWad - decay;
    }

    function stageOf(bytes32 human) public view override returns (uint8) {
        return _stage(human, scoreOf(human));
    }

    /// @notice True once a human holds `ladder.banAtCount` tokens: permanent, nothing lifts it.
    function isBannedForever(bytes32 human) public view returns (bool) {
        uint16 banAt = ladder.banAtCount;
        return banAt != 0 && penaltyCount[human] >= banAt;
    }

    /// @notice Seconds until the score falls strictly below `thresholdPoints` (0 if already below).
    function secondsUntilBelow(bytes32 human, uint32 thresholdPoints) external view returns (uint256) {
        uint256 s = scoreOf(human);
        uint256 t = uint256(thresholdPoints) * WAD;
        if (t == 0) return type(uint256).max; // nothing is strictly below zero (audit I-02)
        if (s < t) return 0;
        uint256 rate = _accounts[human].rateWad;
        if (rate == 0) return type(uint256).max;
        return (s - t) / rate + 1;
    }

    function accountOf(bytes32 human) external view returns (Account memory) {
        return _accounts[human];
    }

    function penaltyOf(uint256 tokenId) external view returns (Penalty memory) {
        return _penalties[tokenId];
    }

    // =============================================================== mint
    /// @notice Record a confirmed mistake. Callable only by the receipts contract (MINTER_ROLE).
    function penalize(bytes32 human, uint256 receiptId, bytes32 evidenceHash, bool major)
        external
        override
        onlyRole(MINTER_ROLE)
        returns (uint256 tokenId)
    {
        if (receiptId == 0) revert ZeroReceipt();
        if (penaltyOfReceipt[receiptId] != 0) revert AlreadyPenalized(receiptId);
        address to = humans.accountOf(human);
        if (to == address(0)) revert UnknownHuman();

        Config memory c = config;
        uint256 cur = scoreOf(human);
        uint16 count = ++penaltyCount[human];
        uint256 weight = ladder.weightByCount
            ? uint256(c.base) * WAD * (major ? c.majorMultiplier : 1) * count
            : uint256(c.base) * WAD * (major ? c.majorMultiplier : 1) + cur * c.escalationBps / BPS;
        uint256 cap = uint256(c.maxScore) * WAD;
        uint256 next = cur + weight;
        if (next > cap) next = cap;

        _store(human, next, c);

        tokenId = nextId++;
        penaltyOfReceipt[receiptId] = tokenId;
        _penalties[tokenId] = Penalty({
            human: human,
            receiptId: receiptId,
            evidenceHash: evidenceHash,
            weightWad: uint128(next - cur), // effective weight after the cap
            mintedAt: uint64(block.timestamp),
            major: major
        });
        _mint(to, tokenId); // no receiver hook: cannot be refused, no reentrancy
        emit Locked(tokenId);
        uint8 stage = _stage(human, next);
        emit Penalized(tokenId, human, receiptId, next - cur, next, stage);
        _publish(human, to, next, stage);
    }

    // ============================================================ forgive
    /// @notice Speed up recovery. Never your own score; always with a reason.
    function forgive(bytes32 human, uint256 amountWad, bytes32 reasonHash) external onlyRole(EVALUATOR_ROLE) {
        if (reasonHash == bytes32(0)) revert ReasonRequired();
        bytes32 self = humans.humanOf(msg.sender);
        if (self == bytes32(0)) revert NotEnrolled();
        if (self == human) revert SelfForgiveness();
        uint256 cur = scoreOf(human);
        uint256 next = amountWad >= cur ? 0 : cur - amountWad;
        _store(human, next, config);
        emit Forgiven(human, msg.sender, cur - next, next, reasonHash);
        _publish(human, humans.accountOf(human), next, _stage(human, next));
    }

    /// @notice The judge lifts a restriction early: score -> 0, the tokens stay. Reason required.
    ///         A ladder ban can never be lifted. The judge need not be enrolled (demo trust assumption).
    function judgeLift(bytes32 human, bytes32 reasonHash) external onlyRole(JUDGE_ROLE) {
        if (reasonHash == bytes32(0)) revert ReasonRequired();
        if (isBannedForever(human)) revert BannedForever();
        bytes32 self = humans.humanOf(msg.sender);
        if (self != bytes32(0) && self == human) revert SelfForgiveness();
        uint256 cur = scoreOf(human);
        _store(human, 0, config);
        emit Forgiven(human, msg.sender, cur, 0, reasonHash);
        _publish(human, humans.accountOf(human), 0, _stage(human, 0));
    }

    /// @notice Permissionless resync of a human's published score. A caller of `finalize` can
    ///         starve the capped publisher call of gas (the penalty still lands, the mirror is
    ///         skipped); anyone can repair the mirror with this (audit L-03).
    function republish(bytes32 human) external {
        uint256 s = scoreOf(human);
        _publish(human, humans.accountOf(human), s, _stage(human, s));
    }

    // ============================================================== admin
    function setConfig(Config calldata cfg) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setConfig(cfg);
    }

    function setLadder(Ladder calldata l) external onlyRole(DEFAULT_ADMIN_ROLE) {
        ladder = l;
        emit LadderSet(l);
    }

    function setPublisher(IScorePublisher p) external onlyRole(DEFAULT_ADMIN_ROLE) {
        publisher = p;
        emit PublisherSet(address(p));
    }

    // =========================================================== internal
    function _setConfig(Config memory c) internal {
        if (
            c.base == 0 || c.majorMultiplier == 0 || c.fadePeriod == 0 || c.maxScore < c.base
                || c.stage2At == 0 || c.stage2At > c.stage3At || c.stage3At > c.maxScore || c.escalationBps > 5 * BPS
        ) revert BadConfig();
        config = c;
        emit ConfigSet(c);
    }

    /// @dev Checkpoint: store the decayed score and snapshot the CURRENT rate for future decay.
    function _store(bytes32 human, uint256 scoreWad, Config memory c) internal {
        _accounts[human] = Account({
            scoreWad: uint128(scoreWad), // <= maxScore * 1e18 < 2^128
            updatedAt: uint64(block.timestamp),
            // rounded UP so a single `base` never outlasts `fadePeriod` (audit L-01)
            rateWad: uint128((uint256(c.base) * WAD + c.fadePeriod - 1) / c.fadePeriod)
        });
    }

    function _stage(bytes32 human, uint256 s) internal view returns (uint8) {
        return isBannedForever(human) ? 3 : _stageFor(s);
    }

    function _stageFor(uint256 s) internal view returns (uint8) {
        if (s == 0) return 0;
        if (s >= uint256(config.stage3At) * WAD) return 3;
        if (s >= uint256(config.stage2At) * WAD) return 2;
        return 1;
    }

    /// @dev Publishing is best-effort with a gas cap: a broken or hostile publisher can
    ///      never block a penalty or a forgiveness.
    function _publish(bytes32 human, address account, uint256 s, uint8 stage) internal {
        if (address(publisher) == address(0) || account == address(0)) return;
        Account memory a = _accounts[human];
        try publisher.publish{gas: 300_000}(account, s, a.updatedAt, a.rateWad, stage) {}
        catch {
            emit PublishFailed(human);
        }
    }

    // ======================================================== soulbound
    function locked(uint256 tokenId) external view returns (bool) {
        _requireOwned(tokenId);
        return true;
    }

    function _update(address to, uint256 tokenId, address auth) internal override returns (address) {
        if (_ownerOf(tokenId) != address(0)) revert Soulbound(); // blocks transfer AND burn
        return super._update(to, tokenId, auth);
    }

    function approve(address, uint256) public pure override {
        revert Soulbound();
    }

    function setApprovalForAll(address, bool) public pure override {
        revert Soulbound();
    }

    function supportsInterface(bytes4 id) public view override(ERC721, AccessControl) returns (bool) {
        return id == 0xb45a3c0e || super.supportsInterface(id);
    }

    /// @notice On-chain JSON: the incident record plus the human's live score and stage.
    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);
        Penalty memory p = _penalties[tokenId];
        uint256 s = scoreOf(p.human);
        string memory json = string.concat(
            '{"name":"HITL Penalty #', tokenId.toString(),
            '","description":"Non-transferable record of a validation confirmed wrong by forensics.","attributes":[',
            '{"trait_type":"receipt","value":', p.receiptId.toString(), "},",
            '{"trait_type":"severity","value":"', p.major ? "major" : "minor", '"},',
            '{"trait_type":"weight","value":', (uint256(p.weightWad) / WAD).toString(), "},",
            '{"trait_type":"issued","display_type":"date","value":', uint256(p.mintedAt).toString(), "},",
            '{"trait_type":"current score","value":', (s / WAD).toString(), "},",
            '{"trait_type":"current stage","value":', uint256(_stage(p.human, s)).toString(), "},",
            '{"trait_type":"human","value":"', uint256(p.human).toHexString(32), '"},',
            '{"trait_type":"evidence","value":"', uint256(p.evidenceHash).toHexString(32), '"}]}'
        );
        return string.concat("data:application/json;base64,", Base64.encode(bytes(json)));
    }
}
