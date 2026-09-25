// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {MockWorldID} from "../src/mocks/Mocks.sol";
import {WorldIDVerifier} from "../src/WorldIDVerifier.sol";
import {HumanRegistry} from "../src/HumanRegistry.sol";
import {PermissionRegistry} from "../src/PermissionRegistry.sol";
import {IPenaltyStages, IPenaltyMinter} from "../src/interfaces/IPenalty.sol";
import {ValidationReceipts} from "../src/ValidationReceipts.sol";
import {PenaltyLedger} from "../src/PenaltyLedger.sol";
import {HumanProof} from "../src/interfaces/IHumanVerifier.sol";

/// @notice Shared fixture. alice = prompter/coder, bob = validator, carol = lead,
///         forensics / appeals / evaluator are separate system accounts.
abstract contract Base is Test {
    MockWorldID world;
    WorldIDVerifier verifier;
    HumanRegistry humans;
    PermissionRegistry perms;
    ValidationReceipts receipts;
    PenaltyLedger ledger;

    address admin = makeAddr("admin");
    address operator = makeAddr("operator");
    address relayer = makeAddr("relayer");
    address forensics = makeAddr("forensics");
    address appeals = makeAddr("appeals");
    address evaluator = makeAddr("evaluator");

    uint256 alicePk = 0xA11CE;
    uint256 bobPk = 0xB0B;
    uint256 carolPk = 0xCA201;
    uint256 malPk = 0x3A11;
    address alice;
    address bob;
    address carol;
    address mal;

    bytes32 constant REPO_WEB = keccak256("acme/web"); //      tier 1
    bytes32 constant REPO_PAY = keccak256("acme/payments"); // tier 2 -> live proof
    bytes32 constant MODEL = keccak256("model:some-llm@2026-09");
    bytes32 constant EVIDENCE = keccak256("forensic report INC-7");
    uint64 constant DAY = 1 days;
    uint256 constant WAD = 1e18;

    // default rulebook: base 100, major x2, +100% of current score, cap 1000,
    // stage 2 (no AI) at 200, stage 3 (banned) at 500, one base fades in 30 days
    function _cfg() internal pure returns (PenaltyLedger.Config memory) {
        return PenaltyLedger.Config({
            base: 100,
            majorMultiplier: 2,
            escalationBps: 10_000,
            maxScore: 1000,
            stage2At: 200,
            stage3At: 500,
            fadePeriod: 30 days
        });
    }

    function setUp() public virtual {
        vm.warp(1_780_000_000);
        alice = vm.addr(alicePk);
        bob = vm.addr(bobPk);
        carol = vm.addr(carolPk);
        mal = vm.addr(malPk);

        world = new MockWorldID();
        verifier = new WorldIDVerifier(world, "app_hitl_demo", "hitl-approve");
        humans = new HumanRegistry(verifier);
        perms = new PermissionRegistry(humans, admin);
        receipts = new ValidationReceipts(humans, perms, verifier, admin);
        ledger = new PenaltyLedger(humans, admin, _cfg());

        vm.startPrank(admin);
        perms.grantRole(perms.SANCTIONER_ROLE(), address(receipts));
        perms.grantRole(perms.OPERATOR_ROLE(), operator);
        perms.setLedger(IPenaltyStages(address(ledger)));
        perms.setPolicy(
            PermissionRegistry.Policy({
                liveProofTier: 2,
                allowSelfApproval: false,
                flagCooldown: DAY,
                flagStrikeWindow: 90 * DAY,
                baselessFlagLimit: 2
            })
        );
        perms.setRepo(REPO_WEB, 1, 1);
        perms.setRepo(REPO_PAY, 2, 2);
        receipts.setLedger(IPenaltyMinter(address(ledger)));
        receipts.setConfig(30 days, 0, address(0)); // appeal window 0: penalty at ruling (overridden per test)
        receipts.grantRole(receipts.FORENSICS_ROLE(), forensics);
        receipts.grantRole(receipts.APPEALS_ROLE(), appeals);
        ledger.grantRole(ledger.MINTER_ROLE(), address(receipts));
        ledger.grantRole(ledger.EVALUATOR_ROLE(), evaluator);
        vm.stopPrank();

        _enroll(alice, 1);
        _enroll(bob, 2);
        _enroll(carol, 3);
        // role holders who rule must be enrolled humans (audit M-01/M-02)
        _enroll(forensics, 10);
        _enroll(appeals, 11);
        _enroll(evaluator, 12);

        vm.startPrank(admin);
        _give(_h(alice), perms.AI_SUBMIT(), 4);
        _give(_h(alice), perms.FLAG(), 1);
        _give(_h(bob), perms.AI_SUBMIT(), 4);
        _give(_h(bob), perms.REPO_TIER(), 2);
        _give(_h(bob), perms.APPROVE_DEPTH(), 400);
        _give(_h(bob), perms.FLAG(), 1);
        _give(_h(carol), perms.REPO_TIER(), 3);
        _give(_h(carol), perms.APPROVE_DEPTH(), 2000);
        _give(_h(carol), perms.GRANT(), 1);
        _give(_h(carol), perms.MERGE_PROTECTED(), 1);
        _give(_h(carol), perms.SOLO_APPROVE(), 1);
        vm.stopPrank();
    }

    // ------------------------------------------------------------ helpers
    function _h(address a) internal view returns (bytes32) {
        return humans.humanOf(a);
    }

    function _give(bytes32 human, bytes32 perm, uint64 v) internal {
        perms.grant(human, perm, v, 365 * DAY);
    }

    function _proof(bytes32 signal, uint256 nullifier) internal view returns (HumanProof memory p) {
        uint256 root = 42;
        uint256 signalHash = uint256(keccak256(abi.encodePacked(signal))) >> 8;
        p.root = root;
        p.nullifier = nullifier;
        p.proof[0] = uint256(keccak256(abi.encode(root, signalHash, nullifier, verifier.externalNullifierHash())));
    }

    function _enroll(address who, uint256 nullifier) internal {
        HumanProof memory p = _proof(humans.enrollSignal(who), nullifier);
        vm.prank(who);
        humans.enroll(p);
    }

    function _approval(bytes32 repo, bytes32 commit, uint32 lines, uint256 nonce)
        internal
        view
        returns (ValidationReceipts.HumanApproval memory a)
    {
        a = ValidationReceipts.HumanApproval({
            sessionId: keccak256("session-1"),
            repoId: repo,
            commitHash: commit,
            contextHash: keccak256(abi.encode("diff+tests+prompt", commit)),
            modelId: MODEL,
            submitter: alice,
            linesChanged: lines,
            rounds: 1,
            nonce: nonce,
            deadline: block.timestamp + 1 hours
        });
    }

    function _noAtt() internal pure returns (ValidationReceipts.Attestation memory a) {}

    function _sign(uint256 pk, ValidationReceipts.HumanApproval memory a) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, receipts.approvalDigest(a));
        return abi.encodePacked(r, s, v);
    }

    function _validate(uint256 pk, bytes32 repo, bytes32 commit, uint256 nonce) internal returns (uint256) {
        ValidationReceipts.HumanApproval memory a = _approval(repo, commit, 120, nonce);
        HumanProof memory none;
        bytes memory sig = _sign(pk, a);
        vm.prank(relayer);
        return receipts.validate(a, sig, none, _noAtt());
    }

    /// forensics: "this validation was wrong"
    function _wrong(uint256 id, bool major) internal {
        vm.prank(forensics);
        receipts.audit(id, false, EVIDENCE, major);
    }

    function _nextCommit() internal returns (bytes32) {
        return keccak256(abi.encode("commit", vm.randomUint()));
    }

    uint256 internal _nonce = 1000;

    function _bobValidates() internal returns (uint256) {
        return _validate(bobPk, REPO_WEB, _nextCommit(), _nonce++);
    }

    function _score(address a) internal view returns (uint256) {
        return ledger.scoreOf(_h(a));
    }
}
