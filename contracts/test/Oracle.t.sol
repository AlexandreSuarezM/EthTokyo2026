// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {Base} from "./Base.t.sol";
import {PermissionRegistry} from "../src/PermissionRegistry.sol";
import {ValidationReceipts} from "../src/ValidationReceipts.sol";

/// @notice Single-user demo additions: the ORACLE (the server that generated the code) penalizes a
///         wrong validation, and the SIMULATED credential level (no World proof, never Orb).
contract OracleTest is Base {
    address oracle = makeAddr("oracle"); // the relayer in the demo: an address, not an enrolled human

    function setUp() public override {
        super.setUp();
        bytes32 role = receipts.ORACLE_ROLE();
        vm.prank(admin);
        receipts.grantRole(role, oracle);
    }

    function _oracle(uint256 id, bool major) internal {
        vm.prank(oracle);
        receipts.oraclePenalize(id, EVIDENCE, major);
    }

    // ================================================================ oracle
    function test_OracleNeedsNoEnrollmentAndPenalizesTheValidator() public {
        assertEq(_h(oracle), bytes32(0)); // not a human
        uint256 id = _bobValidates();
        assertEq(ledger.balanceOf(bob), 0); // no token at validation

        vm.expectEmit(true, true, false, true, address(receipts));
        emit ValidationReceipts.OracleRuled(id, oracle, EVIDENCE);
        _oracle(id, false);

        assertEq(uint8(receipts.receiptOf(id).status), uint8(ValidationReceipts.Status.Missed));
        assertEq(ledger.balanceOf(bob), 1); // soulbound penalty, minted by receipts (MINTER_ROLE)
        assertEq(_score(bob), 100 * WAD);
        (, bytes32 evidence,, bytes32 judge,,,, bool applied) = receipts.rulings(id);
        assertEq(evidence, EVIDENCE);
        assertEq(judge, bytes32(0));
        assertTrue(applied);
    }

    function test_OnlyOracleRoleCanOraclePenalize() public {
        uint256 id = _bobValidates();
        bytes32 role = receipts.ORACLE_ROLE();
        address[3] memory others = [relayer, forensics, bob];
        for (uint256 i; i < others.length; ++i) {
            vm.prank(others[i]);
            vm.expectRevert(
                abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, others[i], role)
            );
            receipts.oraclePenalize(id, EVIDENCE, false);
        }
    }

    function test_OraclePenaltyOncePerReceipt() public {
        uint256 id = _bobValidates();
        _oracle(id, false);
        vm.prank(oracle);
        vm.expectRevert(ValidationReceipts.BadStatus.selector);
        receipts.oraclePenalize(id, EVIDENCE, true);
        vm.prank(forensics); // nor through the human path
        vm.expectRevert(ValidationReceipts.BadStatus.selector);
        receipts.audit(id, false, EVIDENCE, false);
        assertEq(ledger.balanceOf(bob), 1);
    }

    function test_OracleNeedsRealReceiptEvidenceAndWindow() public {
        vm.prank(oracle);
        vm.expectRevert(ValidationReceipts.BadStatus.selector); // unknown receipt
        receipts.oraclePenalize(999, EVIDENCE, false);

        uint256 id = _bobValidates();
        vm.prank(oracle);
        vm.expectRevert(ValidationReceipts.EvidenceRequired.selector);
        receipts.oraclePenalize(id, bytes32(0), false);

        vm.warp(block.timestamp + 30 days + 1); // liability window (30 days in Base)
        vm.prank(oracle);
        vm.expectRevert(ValidationReceipts.LiabilityWindowClosed.selector);
        receipts.oraclePenalize(id, EVIDENCE, false);
        assertEq(ledger.balanceOf(bob), 0);
    }

    function test_OracleCannotPenalizeOverturnedReceipt() public {
        vm.prank(admin);
        receipts.setConfig(30 days, 3 days, address(0));
        uint256 id = _bobValidates();
        _wrong(id, false); // forensics rules wrong; appeal window open
        vm.prank(bob);
        receipts.appeal(id, keccak256("appeal"));
        vm.prank(appeals);
        receipts.resolveAppeal(id, true); // overturned
        vm.prank(oracle);
        vm.expectRevert(ValidationReceipts.BadStatus.selector);
        receipts.oraclePenalize(id, EVIDENCE, false);
    }

    function test_OracleKeepsDueProcessWhenAppealWindowIsOpen() public {
        vm.prank(admin);
        receipts.setConfig(30 days, 3 days, address(0));
        uint256 id = _bobValidates();
        _oracle(id, false);
        assertEq(ledger.balanceOf(bob), 0); // not yet: the validator may appeal

        vm.expectRevert(ValidationReceipts.AppealWindowOpen.selector);
        receipts.finalize(id);
        vm.warp(block.timestamp + 3 days + 1);
        receipts.finalize(id);
        assertEq(ledger.balanceOf(bob), 1);
    }

    function test_OracleCannotRuleOnItsOwnHumansReceipt() public {
        bytes32 role = receipts.ORACLE_ROLE();
        vm.prank(admin);
        receipts.grantRole(role, bob); // misconfiguration: the validator holds the role
        uint256 id = _bobValidates();
        vm.prank(bob);
        vm.expectRevert(ValidationReceipts.OwnReceipt.selector);
        receipts.oraclePenalize(id, EVIDENCE, false);
    }

    function test_OraclePenaltiesEscalateCapAndFade() public {
        // two mistakes reach stage 2 (100, then 100 + 100% of 100 = 300 >= 200)
        _oracle(_bobValidates(), false);
        assertEq(ledger.stageOf(_h(bob)), 1);
        _oracle(_bobValidates(), false);
        assertEq(_score(bob), 300 * WAD);
        assertEq(ledger.stageOf(_h(bob)), 2);
        assertEq(perms.activeValue(_h(bob), perms.AI_SUBMIT()), 0); // stage 2: no AI

        // capped at maxScore, however many mistakes (stage 3 = banned: bob can't validate any more)
        uint256 more = _bobValidates();
        _oracle(more, true);
        assertEq(ledger.stageOf(_h(bob)), 3);
        assertLe(_score(bob), 1000 * WAD);

        // fades: 100 points per 30 days in Base
        uint256 before = _score(bob);
        vm.warp(block.timestamp + 30 days);
        assertApproxEqAbs(_score(bob), before - 100 * WAD, 1e10); // per-second rate rounds down (a few wei)
    }

    function test_OraclePenaltyTokenIsSoulbound() public {
        _oracle(_bobValidates(), false);
        uint256 tokenId = 1;
        assertEq(ledger.ownerOf(tokenId), bob);
        vm.prank(bob);
        vm.expectRevert();
        ledger.transferFrom(bob, alice, tokenId);
        assertEq(ledger.ownerOf(tokenId), bob);
    }

    // ============================================================ simulated
    uint256 constant ATTESTER_PK = 0xA77E57;

    function _enrollSimulated(uint256 pk, bytes32 human) internal returns (address who) {
        who = vm.addr(pk);
        vm.prank(admin);
        humans.setAttester(vm.addr(ATTESTER_PK));
        uint8 level = humans.LEVEL_SIMULATED();
        uint256 deadline = block.timestamp + 10 minutes;
        bytes32 ref = keccak256("simulated-session");
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ATTESTER_PK, humans.enrollDigest(who, human, ref, level, deadline));
        vm.prank(who);
        humans.enrollAttested(human, ref, level, deadline, abi.encodePacked(r, s, v));
    }

    function test_SimulatedLevelIsDistinctFromOrb() public {
        bytes32 human = keccak256("simulated:demo-user");
        _enrollSimulated(0x51A, human);
        assertEq(humans.levelOf(human), 3);
        assertTrue(humans.LEVEL_SIMULATED() != humans.LEVEL_ORB());
        assertTrue(humans.LEVEL_SIMULATED() != humans.LEVEL_SELFIE());
    }

    function test_SimulatedHumanIsCappedLikeSelfie() public {
        bytes32 human = keccak256("simulated:demo-user");
        _enrollSimulated(0x51A, human);
        bytes32 tier = perms.REPO_TIER();
        vm.startPrank(admin);
        vm.expectRevert(PermissionRegistry.AboveSelfieCap.selector);
        perms.grant(human, tier, 2, 365 * DAY);
        perms.grant(human, tier, 1, 365 * DAY);
        vm.stopPrank();
        assertEq(perms.activeValue(human, tier), 1);

        vm.prank(admin); // lowering the cap applies at once
        perms.setPolicy(PermissionRegistry.Policy(2, false, DAY, 90 * DAY, 2, 0));
        assertEq(perms.activeValue(human, tier), 0);
    }
}
