// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {HumanRegistry} from "./HumanRegistry.sol";
import {PermissionRegistry} from "./PermissionRegistry.sol";
import {IHumanVerifier, HumanProof} from "./interfaces/IHumanVerifier.sol";
import {IPenaltyMinter} from "./interfaces/IPenalty.sol";

/// @title ValidationReceipts
/// @notice Records every human validation of AI output. NO token is minted here.
///         A token (the penalty) exists only after forensics confirms a mistake: see PenaltyLedger.
///
///  RECORD     `validate` stores an immutable receipt: who (unique human), what (output hash),
///             what they were shown (context hash), which model, when, and the human-proof ref.
///             It requires the validator's own EIP-712 signature plus a human proof (on-chain
///             World ID, or a backend attestation of a World ID 4.0 proof). Anyone may relay.
///  FORENSICS  Only FORENSICS_ROLE accounts can rule a receipt wrong, never on their own receipt,
///             always with evidence, only within the liability window.
///  DUE PROC.  The validator may appeal once; a different HUMAN (APPEALS_ROLE) decides.
///             The penalty is minted only when due process ends.
///  IDENTITY   Every role holder who rules (forensics, appeals) must be an enrolled human, so
///             "not your own receipt" and "not the same person as the judge" compare unique
///             humans, not addresses a person could multiply (audit M-01, M-02).
///  FEES       Paid by whoever submits the transaction (msg.sender), never pulled from a
///             stored account (audit M-03).
///
///      Valid ──flag──► Flagged ──upheld──► Missed ──appeal──► Appealed ──confirm──► Missed + PENALTY
///        ▲                │                  │                    └──overturn──► Overturned
///        └──── Cleared ◄──┘ rejected         └── no appeal, window over ── finalize() ──► PENALTY
contract ValidationReceipts is AccessControl, EIP712 {
    using SafeERC20 for IERC20;

    bytes32 public constant FORENSICS_ROLE = keccak256("FORENSICS_ROLE");
    bytes32 public constant APPEALS_ROLE = keccak256("APPEALS_ROLE");

    bytes32 public constant APPROVAL_TYPEHASH = keccak256(
        "HumanApproval(bytes32 sessionId,bytes32 repoId,bytes32 commitHash,bytes32 contextHash,bytes32 modelId,address submitter,uint32 linesChanged,uint16 rounds,uint256 nonce,uint256 deadline)"
    );
    bytes32 public constant ATTESTATION_TYPEHASH =
        keccak256("HumanAttestation(bytes32 approvalDigest,bytes32 proofRef,bool presence)");

    struct HumanApproval {
        bytes32 sessionId;
        bytes32 repoId;
        bytes32 commitHash; //  exact output validated
        bytes32 contextHash; // exact context shown to the validator
        bytes32 modelId; //     model + version that produced it (recorded, not judged)
        address submitter; //   human who prompted the AI (may equal the validator if policy allows)
        uint32 linesChanged;
        uint16 rounds; //       deny/resubmit rounds before this accept
        uint256 nonce;
        uint256 deadline;
    }

    struct Attestation {
        bytes32 proofRef; // hash of the verified World ID result (kept off-chain for audit)
        bool presence; //   proof included require_user_presence / liveness
        bytes signature; // attester's EIP-712 signature
    }

    enum Status {
        None,
        Valid,
        Flagged,
        Missed,
        Cleared,
        Appealed,
        Overturned
    }

    struct Receipt {
        bytes32 validatorHuman;
        bytes32 submitterHuman;
        bytes32 repoId;
        bytes32 commitHash;
        bytes32 contextHash;
        bytes32 modelId;
        bytes32 sessionId;
        bytes32 proofRef;
        uint32 linesChanged;
        uint16 rounds;
        uint8 repoTier;
        bool liveProof;
        uint64 validatedAt;
        Status status;
    }

    struct Ruling {
        bytes32 flaggerHuman; // 0 when raised directly by forensics
        bytes32 evidenceHash;
        bytes32 appealHash;
        bytes32 judgeHuman;
        uint64 ruledAt;
        bool major;
        bool appealUsed;
        bool penaltyApplied;
    }

    HumanRegistry public immutable humans;
    PermissionRegistry public immutable perms;
    IHumanVerifier public immutable verifier;
    IPenaltyMinter public ledger;

    uint64 public liabilityWindow = 30 days;
    uint64 public appealWindow = 3 days;
    address public attester; // 0 = on-chain verifier mode

    IERC20 public feeToken;
    address public treasury;
    mapping(uint8 tier => uint256) public feeByTier;

    uint256 public nextId = 1;
    mapping(uint256 id => Receipt) internal _receipts;
    mapping(uint256 id => Ruling) public rulings;
    mapping(bytes32 commitHash => uint256[]) internal _receiptsByCommit;
    mapping(bytes32 commitHash => mapping(bytes32 human => bool)) public validatedBy;
    mapping(address account => mapping(uint256 nonce => bool)) public nonceUsed;

    event Validated(
        uint256 indexed id, bytes32 indexed validatorHuman, bytes32 indexed commitHash, bytes32 repoId, bytes32 modelId, bool liveProof
    );
    event StatusChanged(uint256 indexed id, Status status);
    event Flagged(uint256 indexed id, bytes32 indexed flaggerHuman, bytes32 evidenceHash);
    event Ruled(uint256 indexed id, address indexed judge, bool wrong, bool major);
    event Appealed(uint256 indexed id, bytes32 appealHash);
    event AppealResolved(uint256 indexed id, address indexed reviewer, bool overturned);
    event PenaltyIssued(uint256 indexed id, uint256 indexed penaltyTokenId);
    event ConfigChanged(uint64 liabilityWindow, uint64 appealWindow, address indexed attester);
    event LedgerSet(address indexed ledger);

    error Expired();
    error NonceUsed();
    error BadSignature();
    error BadAttestation();
    error SelfApproval();
    error Banned();
    error InsufficientPermission(bytes32 perm);
    error LiveProofMismatch();
    error LiveProofRequired();
    error AlreadyValidated();
    error BadStatus();
    error EvidenceRequired();
    error LiabilityWindowClosed();
    error AppealWindowClosed();
    error AppealWindowOpen();
    error NotTheValidator();
    error SameReviewerAsJudge();
    error OwnReceipt();
    error LedgerNotSet();
    error NotEnrolled();
    error ZeroTreasury();

    constructor(HumanRegistry _humans, PermissionRegistry _perms, IHumanVerifier _verifier, address admin)
        EIP712("HITLValidationReceipts", "1")
    {
        humans = _humans;
        perms = _perms;
        verifier = _verifier;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    // ============================================================ validation
    function validate(
        HumanApproval calldata a,
        bytes calldata signature,
        HumanProof calldata live,
        Attestation calldata att
    ) external returns (uint256 id) {
        if (block.timestamp > a.deadline) revert Expired();

        // 1. key authentication
        bytes32 digest = _hashTypedDataV4(_structHash(a));
        address validator = ECDSA.recover(digest, signature);
        bytes32 validatorHuman = humans.humanOf(validator);
        if (validatorHuman == bytes32(0)) revert BadSignature(); // not an enrolled key
        if (nonceUsed[validator][a.nonce]) revert NonceUsed();
        nonceUsed[validator][a.nonce] = true;

        bytes32 submitterHuman = humans.requireHuman(a.submitter);
        if (validatedBy[a.commitHash][validatorHuman]) revert AlreadyValidated();

        // 2. authorization (stage 3 = banned, checked explicitly for a clear error)
        if (address(ledger) != address(0) && ledger.stageOf(validatorHuman) >= 3) revert Banned();
        PermissionRegistry.Repo memory r = perms.repo(a.repoId);
        _checkPermissions(validatorHuman, submitterHuman, r.tier, a.linesChanged);

        // 3. human proof at the moment of validation
        (bool isLive, bytes32 proofRef) =
            _checkHumanProof(digest, a.commitHash, validator, validatorHuman, r.tier, live, att);

        // 4. effects before interactions
        id = nextId++;
        _receipts[id] = Receipt({
            validatorHuman: validatorHuman,
            submitterHuman: submitterHuman,
            repoId: a.repoId,
            commitHash: a.commitHash,
            contextHash: a.contextHash,
            modelId: a.modelId,
            sessionId: a.sessionId,
            proofRef: proofRef,
            linesChanged: a.linesChanged,
            rounds: a.rounds,
            repoTier: r.tier,
            liveProof: isLive,
            validatedAt: uint64(block.timestamp),
            status: Status.Valid
        });
        validatedBy[a.commitHash][validatorHuman] = true;
        _receiptsByCommit[a.commitHash].push(id);
        emit Validated(id, validatorHuman, a.commitHash, a.repoId, a.modelId, isLive);

        // 5. optional fee, paid by the submitter of this transaction (interaction last)
        uint256 fee = feeByTier[r.tier];
        if (fee != 0 && address(feeToken) != address(0)) {
            feeToken.safeTransferFrom(msg.sender, treasury, fee);
        }
    }

    function _checkPermissions(bytes32 validatorHuman, bytes32 submitterHuman, uint8 tier, uint32 lines)
        internal
        view
    {
        (, bool allowSelf,,,,) = perms.policy();
        if (!allowSelf && validatorHuman == submitterHuman) revert SelfApproval();
        if (!perms.has(validatorHuman, perms.REPO_TIER(), tier == 0 ? 1 : tier)) {
            revert InsufficientPermission(perms.REPO_TIER());
        }
        if (!perms.has(validatorHuman, perms.APPROVE_DEPTH(), lines)) {
            revert InsufficientPermission(perms.APPROVE_DEPTH());
        }
    }

    function _checkHumanProof(
        bytes32 digest,
        bytes32 commitHash,
        address validator,
        bytes32 validatorHuman,
        uint8 tier,
        HumanProof calldata live,
        Attestation calldata att
    ) internal view returns (bool isLive, bytes32 proofRef) {
        (uint8 liveTier,,,,,) = perms.policy();
        bool needLive = tier >= liveTier;

        if (attester != address(0)) {
            bytes32 attDigest =
                _hashTypedDataV4(keccak256(abi.encode(ATTESTATION_TYPEHASH, digest, att.proofRef, att.presence)));
            if (att.proofRef == bytes32(0) || ECDSA.recover(attDigest, att.signature) != attester) {
                revert BadAttestation();
            }
            if (needLive && !att.presence) revert LiveProofRequired();
            return (att.presence, att.proofRef);
        }

        if (!needLive) return (false, bytes32(0));
        if (bytes32(live.nullifier) != validatorHuman) revert LiveProofMismatch();
        verifier.verify(liveSignal(commitHash, validator), live);
        return (true, keccak256(abi.encode(live.root, live.nullifier, live.proof)));
    }

    function liveSignal(bytes32 commitHash, address validator) public pure returns (bytes32) {
        return keccak256(abi.encode("hitl.approve", commitHash, validator));
    }

    function approvalDigest(HumanApproval calldata a) external view returns (bytes32) {
        return _hashTypedDataV4(_structHash(a));
    }

    function attestationDigest(bytes32 approvalDigest_, bytes32 proofRef, bool presence)
        external
        view
        returns (bytes32)
    {
        return _hashTypedDataV4(keccak256(abi.encode(ATTESTATION_TYPEHASH, approvalDigest_, proofRef, presence)));
    }

    function _structHash(HumanApproval calldata a) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                APPROVAL_TYPEHASH,
                a.sessionId,
                a.repoId,
                a.commitHash,
                a.contextHash,
                a.modelId,
                a.submitter,
                a.linesChanged,
                a.rounds,
                a.nonce,
                a.deadline
            )
        );
    }

    // ========================================================= merge gate
    function canMerge(address merger, bytes32 repoId, bytes32 commitHash) external view returns (bool) {
        bytes32 mergerHuman = humans.humanOf(merger);
        if (mergerHuman == bytes32(0) || !perms.has(mergerHuman, perms.MERGE_PROTECTED(), 1)) return false;
        PermissionRegistry.Repo memory r = perms.repo(repoId);
        uint256[] storage ids = _receiptsByCommit[commitHash];
        uint256 valid;
        bool solo;
        for (uint256 i; i < ids.length; ++i) {
            Receipt storage rc = _receipts[ids[i]];
            if (rc.repoId != repoId || !_standing(rc.status)) continue;
            valid++;
            if (perms.has(rc.validatorHuman, perms.SOLO_APPROVE(), 1)) solo = true;
        }
        return valid >= (solo ? 1 : r.requiredApprovals);
    }

    // ============================================================ forensics
    /// @notice Anyone holding FLAG may raise a case, with evidence, inside the liability window.
    function flag(uint256 id, bytes32 evidenceHash) external {
        bytes32 flagger = humans.requireHuman(msg.sender);
        if (!perms.has(flagger, perms.FLAG(), 1)) revert InsufficientPermission(perms.FLAG());
        _openCase(id, flagger, evidenceHash);
        emit Flagged(id, flagger, evidenceHash);
        emit StatusChanged(id, Status.Flagged);
    }

    /// @notice Forensics rules on a flagged receipt.
    function resolveFlag(uint256 id, bool wrong, bool major) external onlyRole(FORENSICS_ROLE) {
        if (_receipts[id].status != Status.Flagged) revert BadStatus();
        _rule(id, wrong, major);
    }

    /// @notice "Was the validation right?" — forensics opens and rules in one call (demo helper
    ///         and the normal path when forensics finds the error itself).
    function audit(uint256 id, bool correct, bytes32 evidenceHash, bool major) external onlyRole(FORENSICS_ROLE) {
        _openCase(id, bytes32(0), evidenceHash);
        emit StatusChanged(id, Status.Flagged);
        _rule(id, !correct, major);
    }

    function appeal(uint256 id, bytes32 appealHash) external {
        Receipt storage rc = _receipts[id];
        Ruling storage r = rulings[id];
        bytes32 caller = humans.humanOf(msg.sender);
        if (caller == bytes32(0) || caller != rc.validatorHuman) revert NotTheValidator();
        if (rc.status != Status.Missed || r.appealUsed || r.penaltyApplied) revert BadStatus();
        if (block.timestamp > r.ruledAt + appealWindow) revert AppealWindowClosed();
        r.appealUsed = true;
        r.appealHash = appealHash;
        rc.status = Status.Appealed;
        emit Appealed(id, appealHash);
        emit StatusChanged(id, Status.Appealed);
    }

    function resolveAppeal(uint256 id, bool overturn) external onlyRole(APPEALS_ROLE) {
        Receipt storage rc = _receipts[id];
        Ruling storage r = rulings[id];
        if (rc.status != Status.Appealed) revert BadStatus();
        bytes32 reviewer = humans.humanOf(msg.sender);
        if (reviewer == bytes32(0)) revert NotEnrolled();
        if (reviewer == rc.validatorHuman) revert OwnReceipt();
        if (reviewer == r.judgeHuman) revert SameReviewerAsJudge();
        emit AppealResolved(id, msg.sender, overturn);
        if (overturn) {
            rc.status = Status.Overturned;
            emit StatusChanged(id, Status.Overturned);
            if (r.flaggerHuman != bytes32(0)) perms.penalizeBaselessFlag(r.flaggerHuman);
        } else {
            rc.status = Status.Missed;
            emit StatusChanged(id, Status.Missed);
            _issuePenalty(id);
        }
    }

    function finalize(uint256 id) external {
        Ruling storage r = rulings[id];
        if (_receipts[id].status != Status.Missed || r.penaltyApplied) revert BadStatus();
        if (block.timestamp <= r.ruledAt + appealWindow) revert AppealWindowOpen();
        _issuePenalty(id);
    }

    function _openCase(uint256 id, bytes32 flagger, bytes32 evidenceHash) internal {
        Receipt storage rc = _receipts[id];
        if (rc.status != Status.Valid && rc.status != Status.Cleared) revert BadStatus(); // also rejects unknown ids
        if (evidenceHash == bytes32(0)) revert EvidenceRequired();
        if (block.timestamp > rc.validatedAt + liabilityWindow) revert LiabilityWindowClosed();
        rc.status = Status.Flagged;
        Ruling storage r = rulings[id];
        r.flaggerHuman = flagger;
        r.evidenceHash = evidenceHash;
    }

    function _rule(uint256 id, bool wrong, bool major) internal {
        Receipt storage rc = _receipts[id];
        bytes32 judgeHuman = humans.humanOf(msg.sender);
        if (judgeHuman == bytes32(0)) revert NotEnrolled();
        if (judgeHuman == rc.validatorHuman) revert OwnReceipt();
        Ruling storage r = rulings[id];
        r.judgeHuman = judgeHuman;
        r.ruledAt = uint64(block.timestamp);
        r.major = major;
        emit Ruled(id, msg.sender, wrong, major);
        if (wrong) {
            rc.status = Status.Missed;
            emit StatusChanged(id, Status.Missed);
            if (appealWindow == 0) _issuePenalty(id);
        } else {
            rc.status = Status.Cleared;
            emit StatusChanged(id, Status.Cleared);
            if (r.flaggerHuman != bytes32(0)) perms.penalizeBaselessFlag(r.flaggerHuman);
        }
    }

    function _issuePenalty(uint256 id) internal {
        if (address(ledger) == address(0)) revert LedgerNotSet();
        Receipt storage rc = _receipts[id];
        Ruling storage r = rulings[id];
        r.penaltyApplied = true; // effects before the external call
        if (r.flaggerHuman != bytes32(0)) perms.recordCatch(r.flaggerHuman);
        uint256 tokenId = ledger.penalize(rc.validatorHuman, id, r.evidenceHash, r.major);
        emit PenaltyIssued(id, tokenId);
    }

    function _standing(Status s) internal pure returns (bool) {
        return s == Status.Valid || s == Status.Cleared || s == Status.Overturned;
    }

    // ============================================================== reads
    function receiptOf(uint256 id) external view returns (Receipt memory) {
        return _receipts[id];
    }

    function receiptsByCommit(bytes32 commitHash) external view returns (uint256[] memory) {
        return _receiptsByCommit[commitHash];
    }

    /// @notice A validation is a settled success once its liability window closed while standing.
    function isSettledSuccess(uint256 id) external view returns (bool) {
        Receipt storage rc = _receipts[id];
        return _standing(rc.status) && block.timestamp > rc.validatedAt + liabilityWindow;
    }

    // ============================================================== admin
    function setLedger(IPenaltyMinter l) external onlyRole(DEFAULT_ADMIN_ROLE) {
        ledger = l;
        emit LedgerSet(address(l));
    }

    function setConfig(uint64 _liabilityWindow, uint64 _appealWindow, address _attester)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        liabilityWindow = _liabilityWindow;
        appealWindow = _appealWindow;
        attester = _attester;
        emit ConfigChanged(_liabilityWindow, _appealWindow, _attester);
    }

    function setFees(IERC20 token, address _treasury, uint8[] calldata tiers, uint256[] calldata amounts)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        require(tiers.length == amounts.length, "length");
        if (address(token) != address(0) && _treasury == address(0)) revert ZeroTreasury();
        feeToken = token;
        treasury = _treasury;
        for (uint256 i; i < tiers.length; ++i) feeByTier[tiers[i]] = amounts[i];
    }
}
