// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {HumanRegistry, CREDENTIAL_SELFIE} from "./HumanRegistry.sol";
import {IRoleMirror} from "./interfaces/IHumanVerifier.sol";
import {IPenaltyStages} from "./interfaces/IPenalty.sol";

/// @title PermissionRegistry
/// @notice Source of truth for what each HUMAN may do.
/// @dev Keyed by humanId. Every grant has an expiry. Penalties do not live here: the
///      PenaltyLedger holds the decaying score and this contract only READS its stage:
///        stage 2 -> AI_SUBMIT is inactive (no AI access)
///        stage 3 -> every permission is inactive (banned)
///      Stages lift by themselves as the score fades, so nothing here needs undoing.
///      Credential level: a Selfie-level human's REPO_TIER is capped at policy.maxTierForSelfie
///      when read, so lowering the cap takes effect at once without rewriting grants.
contract PermissionRegistry is AccessControl {
    // ------------------------------------------------------------------ roles
    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE"); //     orchestrator (quotas)
    bytes32 public constant SANCTIONER_ROLE = keccak256("SANCTIONER_ROLE"); // receipts contract (flag abuse)

    // ------------------------------------------------------------ permissions
    bytes32 public constant REPO_TIER = keccak256("REPO_TIER"); //      max repo risk tier (0..255)
    bytes32 public constant APPROVE_DEPTH = keccak256("APPROVE_DEPTH"); // max lines per approval
    bytes32 public constant SOLO_APPROVE = keccak256("SOLO_APPROVE"); //  1 = may be the only approver
    bytes32 public constant AI_SUBMIT = keccak256("AI_SUBMIT"); //        AI submissions per day
    bytes32 public constant MERGE_PROTECTED = keccak256("MERGE_PROTECTED"); // 1 = may merge protected
    bytes32 public constant GRANT = keccak256("GRANT"); //                1 = may sponsor others
    bytes32 public constant FLAG = keccak256("FLAG"); //                  1 = may flag receipts

    struct Grant {
        uint64 value;
        uint64 expiresAt;
        uint64 suspendedUntil;
    }

    struct Repo {
        uint8 tier; //              risk tier of the repository
        uint8 requiredApprovals; // receipts needed to merge (1 if an approver has SOLO_APPROVE)
        bool exists;
    }

    /// @notice Environment policy. Loaded from an environment preset file (see /environments).
    struct Policy {
        uint8 liveProofTier; //     repos at or above this tier need a live personhood proof
        bool allowSelfApproval; //  may the prompter of the AI also validate its output?
        uint64 flagCooldown; //     seconds FLAG is suspended after too many rejected flags
        uint64 flagStrikeWindow; // rejected-flag strikes older than this are forgotten
        uint8 baselessFlagLimit; // rejected flags before FLAG is suspended
        uint8 maxTierForSelfie; //  highest REPO_TIER a Selfie-level human may hold (0 = no repo access)
    }

    struct Preset {
        bytes32[] perms;
        uint64[] values;
        uint64 duration;
    }

    struct Counter {
        uint32 count;
        uint64 last;
    }

    HumanRegistry public immutable humans;
    IRoleMirror public mirror;
    IPenaltyStages public ledger;
    Policy public policy;

    mapping(bytes32 human => mapping(bytes32 perm => Grant)) internal _grants;
    mapping(bytes32 human => bytes32 sponsor) public sponsorOf;
    mapping(bytes32 human => Counter) public flagStrikes;
    mapping(bytes32 human => uint32) public catches;
    mapping(bytes32 human => mapping(uint64 day => uint32)) public submissionsOn;
    mapping(bytes32 repoId => Repo) public repos;
    mapping(bytes32 presetId => Preset) internal _presets;

    event Granted(bytes32 indexed human, bytes32 indexed perm, uint64 value, uint64 expiresAt, bytes32 sponsor);
    event Revoked(bytes32 indexed human, bytes32 indexed perm);
    event Suspended(bytes32 indexed human, bytes32 indexed perm, uint64 until);
    event FlagStrike(bytes32 indexed human, uint32 count);
    event PolicySet(Policy policy);
    event RepoSet(bytes32 indexed repoId, uint8 tier, uint8 requiredApprovals);
    event PresetDefined(bytes32 indexed presetId);
    event LedgerSet(address indexed ledger);

    error NotAllowedToGrant();
    error QuotaExceeded();
    error UnknownRepo();
    error LengthMismatch();
    error AboveSelfieCap();

    constructor(HumanRegistry _humans, address admin) {
        humans = _humans;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    // ================================================================ config
    function setPolicy(Policy calldata p) external onlyRole(DEFAULT_ADMIN_ROLE) {
        policy = p;
        emit PolicySet(p);
    }

    function setRepo(bytes32 repoId, uint8 tier, uint8 requiredApprovals) external onlyRole(DEFAULT_ADMIN_ROLE) {
        repos[repoId] = Repo(tier, requiredApprovals == 0 ? 1 : requiredApprovals, true);
        emit RepoSet(repoId, tier, requiredApprovals);
    }

    function setMirror(IRoleMirror m) external onlyRole(DEFAULT_ADMIN_ROLE) {
        mirror = m;
    }

    function setLedger(IPenaltyStages l) external onlyRole(DEFAULT_ADMIN_ROLE) {
        ledger = l;
        emit LedgerSet(address(l));
    }

    /// @notice A preset is a named bundle of grants ("junior", "reviewer", "lead"...).
    function definePreset(bytes32 presetId, bytes32[] calldata perms, uint64[] calldata values, uint64 duration)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        if (perms.length != values.length) revert LengthMismatch();
        _presets[presetId] = Preset(perms, values, duration);
        emit PresetDefined(presetId);
    }

    function presetOf(bytes32 presetId) external view returns (Preset memory) {
        return _presets[presetId];
    }

    // ================================================================ grants
    function grant(bytes32 human, bytes32 perm, uint64 value, uint64 duration) public {
        bytes32 sponsor = _checkGranter(perm, value);
        _grant(human, perm, value, duration, sponsor);
    }

    function applyPreset(bytes32 human, bytes32 presetId) external {
        Preset storage p = _presets[presetId];
        for (uint256 i; i < p.perms.length; ++i) {
            bytes32 sponsor = _checkGranter(p.perms[i], p.values[i]);
            _grant(human, p.perms[i], p.values[i], p.duration, sponsor);
        }
    }

    function revoke(bytes32 human, bytes32 perm) external onlyRole(DEFAULT_ADMIN_ROLE) {
        delete _grants[human][perm];
        emit Revoked(human, perm);
        _sync(human, perm);
    }

    /// @dev Admin grants carry no sponsor. A human granter must hold GRANT and must itself hold
    ///      at least the value being granted: nobody can hand out more than they have.
    ///      A granter can never grant to themselves (no self-escalation).
    function _checkGranter(bytes32 perm, uint64 value) internal view returns (bytes32 sponsor) {
        if (hasRole(DEFAULT_ADMIN_ROLE, msg.sender)) return bytes32(0);
        sponsor = humans.humanOf(msg.sender);
        if (sponsor == bytes32(0) || !has(sponsor, GRANT, 1) || !has(sponsor, perm, value)) {
            revert NotAllowedToGrant();
        }
    }

    function _grant(bytes32 human, bytes32 perm, uint64 value, uint64 duration, bytes32 sponsor) internal {
        if (sponsor != bytes32(0) && sponsor == human) revert NotAllowedToGrant();
        if (perm == REPO_TIER && value > policy.maxTierForSelfie && _isSelfie(human)) revert AboveSelfieCap();
        Grant storage g = _grants[human][perm];
        g.value = value;
        g.expiresAt = uint64(block.timestamp) + duration;
        if (sponsor != bytes32(0) && sponsorOf[human] == bytes32(0)) sponsorOf[human] = sponsor;
        emit Granted(human, perm, value, g.expiresAt, sponsor);
        _sync(human, perm);
    }

    // ================================================================= reads
    function grantOf(bytes32 human, bytes32 perm) external view returns (Grant memory) {
        return _grants[human][perm];
    }

    /// @notice Value of an ACTIVE permission (0 if expired, suspended, or blocked by penalty stage).
    function activeValue(bytes32 human, bytes32 perm) public view returns (uint64) {
        Grant storage g = _grants[human][perm];
        if (block.timestamp >= g.expiresAt || block.timestamp < g.suspendedUntil) return 0;
        if (address(ledger) != address(0)) {
            uint8 stage = ledger.stageOf(human);
            if (stage >= 3) return 0; //                       banned
            if (stage >= 2 && perm == AI_SUBMIT) return 0; //  no AI access
        }
        if (perm == REPO_TIER && _isSelfie(human)) {
            uint64 cap = policy.maxTierForSelfie;
            return g.value < cap ? g.value : cap;
        }
        return g.value;
    }

    function _isSelfie(bytes32 human) internal view returns (bool) {
        return humans.levelOf(human) == CREDENTIAL_SELFIE;
    }

    function has(bytes32 human, bytes32 perm, uint64 minValue) public view returns (bool) {
        uint64 v = activeValue(human, perm);
        return v != 0 && v >= minValue;
    }

    function stageOf(bytes32 human) external view returns (uint8) {
        return address(ledger) == address(0) ? 0 : ledger.stageOf(human);
    }

    function repo(bytes32 repoId) external view returns (Repo memory r) {
        r = repos[repoId];
        if (!r.exists) revert UnknownRepo();
    }

    // ============================================================ operations
    /// @notice Called by the orchestrator on EVERY AI submission (including re-submissions after
    ///         a deny), so AI_SUBMIT is a real daily budget. Stage 2+ makes the budget 0.
    function consumeSubmission(bytes32 human) external onlyRole(OPERATOR_ROLE) {
        uint64 day = uint64(block.timestamp / 1 days);
        uint32 used = submissionsOn[human][day];
        if (used >= activeValue(human, AI_SUBMIT)) revert QuotaExceeded();
        submissionsOn[human][day] = used + 1;
    }

    // ==================================================== flag abuse control
    /// @notice A rejected flag. Flagging is not free, or it becomes a griefing tool.
    function penalizeBaselessFlag(bytes32 flagger) external onlyRole(SANCTIONER_ROLE) {
        Counter storage c = flagStrikes[flagger];
        if (c.last != 0 && block.timestamp - c.last > policy.flagStrikeWindow) c.count = 0;
        c.count += 1;
        c.last = uint64(block.timestamp);
        emit FlagStrike(flagger, c.count);
        if (policy.baselessFlagLimit != 0 && c.count >= policy.baselessFlagLimit) {
            c.count = 0; // state first: _suspend may call the (gas-capped) mirror (audit L-02)
            _suspend(flagger, FLAG, policy.flagCooldown);
        }
    }

    function recordCatch(bytes32 flagger) external onlyRole(SANCTIONER_ROLE) {
        catches[flagger] += 1;
    }

    // ============================================================== internal
    function _suspend(bytes32 human, bytes32 perm, uint64 d) internal {
        Grant storage g = _grants[human][perm];
        uint64 until = uint64(block.timestamp) + d;
        if (until > g.suspendedUntil) g.suspendedUntil = until;
        emit Suspended(human, perm, g.suspendedUntil);
        _sync(human, perm);
    }

    /// @dev Mirror failures never block enforcement; gas-capped so a hostile mirror can't grief.
    function _sync(bytes32 human, bytes32 perm) internal {
        if (address(mirror) == address(0)) return;
        Grant storage g = _grants[human][perm];
        uint64 activeUntil = g.suspendedUntil > block.timestamp ? uint64(block.timestamp) : g.expiresAt;
        try mirror.sync{gas: 300_000}(humans.accountOf(human), perm, g.value, activeUntil) {} catch {}
    }
}
