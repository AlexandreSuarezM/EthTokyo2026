// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {Base} from "./Base.t.sol";
import {HumanRegistry} from "../src/HumanRegistry.sol";
import {PermissionRegistry} from "../src/PermissionRegistry.sol";
import {ValidationReceipts} from "../src/ValidationReceipts.sol";
import {PenaltyLedger, IScorePublisher} from "../src/PenaltyLedger.sol";
import {HumanProof} from "../src/interfaces/IHumanVerifier.sol";

/// @dev A contract wallet with no onERC721Received: would reject a _safeMint.
contract RejectingWallet {
    function rotate(HumanRegistry h, HumanProof calldata p) external {
        h.rotateKey(p);
    }
}

contract RevertingPublisher is IScorePublisher {
    function publish(address, uint256, uint64, uint256, uint8) external pure {
        revert("nope");
    }
}

contract GasBurningPublisher is IScorePublisher {
    uint256 public sink;

    function publish(address, uint256, uint64, uint256, uint8) external {
        while (true) sink++;
    }
}

contract LedgerTest is Base {
    uint256 constant RATE = (uint256(100) * 1e18 + 30 days - 1) / 30 days;

    // ---------------------------------------------------------- mint rights
    function test_OnlyReceiptsContractCanMint() public {
        bytes32 role = ledger.MINTER_ROLE();
        bytes32 bobH = _h(bob);
        vm.prank(forensics); // even forensics cannot bypass the receipt flow
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, forensics, role));
        ledger.penalize(bobH, 1, EVIDENCE, false);
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, admin, role));
        ledger.penalize(bobH, 1, EVIDENCE, false);
    }

    function test_MinterGuards() public {
        address m = makeAddr("minter");
        bytes32 role = ledger.MINTER_ROLE();
        bytes32 bobH = _h(bob);
        vm.prank(admin);
        ledger.grantRole(role, m);
        vm.startPrank(m);
        vm.expectRevert(PenaltyLedger.ZeroReceipt.selector);
        ledger.penalize(bobH, 0, EVIDENCE, false);
        vm.expectRevert(PenaltyLedger.UnknownHuman.selector);
        ledger.penalize(keccak256("nobody"), 1, EVIDENCE, false);
        ledger.penalize(bobH, 1, EVIDENCE, false);
        vm.expectRevert(abi.encodeWithSelector(PenaltyLedger.AlreadyPenalized.selector, 1));
        ledger.penalize(bobH, 1, EVIDENCE, false);
        vm.stopPrank();
    }

    // ---------------------------------------------------- escalation & cap
    function test_RepeatMistakesEscalateToBanAndCap() public {
        _wrong(_bobValidates(), false);
        assertEq(_score(bob), 100 * WAD);
        assertEq(ledger.stageOf(_h(bob)), 1, "stage 1: losing score");

        _wrong(_bobValidates(), false); // 100 + 100% of 100
        assertEq(_score(bob), 300 * WAD);
        assertEq(ledger.stageOf(_h(bob)), 2, "stage 2: no AI");

        _wrong(_bobValidates(), false); // 100 + 100% of 300
        assertEq(_score(bob), 700 * WAD);
        assertEq(ledger.stageOf(_h(bob)), 3, "stage 3: banned");

        // banned: cannot validate, so no 4th receipt can even exist; force one via a pre-ban receipt
    }

    function test_CapHolds() public {
        uint256[] memory ids = new uint256[](4);
        for (uint256 i; i < 4; ++i) ids[i] = _bobValidates(); // all recorded before any penalty
        for (uint256 i; i < 4; ++i) _wrong(ids[i], true);
        assertEq(_score(bob), 1000 * WAD, "capped");
        assertEq(ledger.balanceOf(bob), 4, "every confirmed mistake is still recorded");
    }

    // -------------------------------------------------------------- stages
    function test_Stage2BlocksAIOnly() public {
        _wrong(_bobValidates(), false);
        _wrong(_bobValidates(), false); // 300 -> stage 2
        bytes32 bobH = _h(bob);
        vm.prank(operator);
        vm.expectRevert(PermissionRegistry.QuotaExceeded.selector);
        perms.consumeSubmission(bobH);
        _bobValidates(); // can still validate
    }

    function test_Stage3Bans() public {
        uint256 pending = _bobValidates();
        for (uint256 i; i < 3; ++i) _wrong(_bobValidates(), false); // 700 -> stage 3
        ValidationReceipts.HumanApproval memory a = _approval(REPO_WEB, keccak256("banned"), 10, 1);
        HumanProof memory none;
        bytes memory sig = _sign(bobPk, a);
        vm.expectRevert(ValidationReceipts.Banned.selector);
        receipts.validate(a, sig, none, _noAtt());
        bytes32 flagP = perms.FLAG();
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(ValidationReceipts.InsufficientPermission.selector, flagP));
        receipts.flag(pending, EVIDENCE);
        assertEq(perms.activeValue(_h(bob), perms.REPO_TIER()), 0);
    }

    // ---------------------------------------------------------------- fade
    function test_OneMinorMistakeFadesInOneMonth() public {
        _wrong(_bobValidates(), false);
        vm.warp(vm.getBlockTimestamp() + 15 days);
        assertApproxEqAbs(_score(bob), 50 * WAD, 1e6);
        vm.warp(vm.getBlockTimestamp() + 15 days);
        assertEq(_score(bob), 0, "exactly one month");
        assertEq(ledger.stageOf(_h(bob)), 0);
    }

    function test_BanLiftsByItself() public {
        for (uint256 i; i < 3; ++i) _wrong(_bobValidates(), false); // 700
        uint256 untilUnban = ledger.secondsUntilBelow(_h(bob), 500);
        assertApproxEqAbs(untilUnban, 60 days, 2);
        vm.warp(vm.getBlockTimestamp() + untilUnban);
        assertEq(ledger.stageOf(_h(bob)), 2, "ban lifted, still no AI");
        vm.warp(vm.getBlockTimestamp() + ledger.secondsUntilBelow(_h(bob), 200));
        assertEq(ledger.stageOf(_h(bob)), 1);
        vm.warp(vm.getBlockTimestamp() + 60 days + 1);
        assertEq(ledger.stageOf(_h(bob)), 0);
    }

    function test_ConfigChangeIsNotRetroactive() public {
        _wrong(_bobValidates(), false);
        PenaltyLedger.Config memory c = _cfg();
        c.fadePeriod = 1; // would erase everything in 1s if applied retroactively
        vm.prank(admin);
        ledger.setConfig(c);
        vm.warp(vm.getBlockTimestamp() + 1 days);
        assertEq(_score(bob), 100 * WAD - RATE * 1 days, "old rate still applies to old score");
    }

    // ------------------------------------------------------------- forgive
    function test_EvaluatorForgivesToSpeedRecovery() public {
        for (uint256 i; i < 3; ++i) _wrong(_bobValidates(), false); // 700, banned
        bytes32 bobH = _h(bob);
        vm.prank(evaluator);
        ledger.forgive(bobH, 300 * WAD, keccak256("completed review training"));
        assertEq(_score(bob), 400 * WAD);
        assertEq(ledger.stageOf(bobH), 2);
        vm.prank(evaluator);
        ledger.forgive(bobH, type(uint256).max, keccak256("full pardon"));
        assertEq(_score(bob), 0, "no underflow");
        assertEq(ledger.balanceOf(bob), 3, "records are never deleted");
    }

    function test_ForgiveGuards() public {
        _wrong(_bobValidates(), false);
        bytes32 bobH = _h(bob);
        vm.prank(evaluator);
        vm.expectRevert(PenaltyLedger.ReasonRequired.selector);
        ledger.forgive(bobH, WAD, bytes32(0));
        bytes32 role = ledger.EVALUATOR_ROLE();
        vm.prank(admin);
        ledger.grantRole(role, bob);
        vm.prank(bob);
        vm.expectRevert(PenaltyLedger.SelfForgiveness.selector);
        ledger.forgive(bobH, WAD, "me");
        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, carol, role));
        ledger.forgive(bobH, WAD, "r");
    }

    // ---------------------------------------------------------- soulbound
    function test_PenaltyIsNotTransferableOrBurnable() public {
        _wrong(_bobValidates(), false);
        vm.startPrank(bob);
        vm.expectRevert(PenaltyLedger.Soulbound.selector);
        ledger.transferFrom(bob, mal, 1);
        vm.expectRevert(PenaltyLedger.Soulbound.selector);
        ledger.safeTransferFrom(bob, mal, 1);
        vm.expectRevert(PenaltyLedger.Soulbound.selector);
        ledger.approve(mal, 1);
        vm.expectRevert(PenaltyLedger.Soulbound.selector);
        ledger.setApprovalForAll(mal, true);
        vm.stopPrank();
        assertTrue(ledger.locked(1));
        assertTrue(ledger.supportsInterface(0xb45a3c0e));
    }

    function test_ContractWalletCannotRefusePenalty() public {
        uint256 id = _bobValidates();
        RejectingWallet w = new RejectingWallet();
        HumanProof memory p = _proof(humans.rotateSignal(address(w)), 2);
        w.rotate(humans, p); // bob's human now lives at a contract that rejects safe mints
        _wrong(id, false);
        assertEq(ledger.ownerOf(1), address(w));
    }

    function test_M_UnenrolledEvaluatorCannotForgive() public {
        _wrong(_bobValidates(), false);
        address sock = makeAddr("evaluator-sock");
        bytes32 role = ledger.EVALUATOR_ROLE();
        bytes32 bobH = _h(bob);
        vm.prank(admin);
        ledger.grantRole(role, sock);
        vm.prank(sock);
        vm.expectRevert(PenaltyLedger.NotEnrolled.selector);
        ledger.forgive(bobH, WAD, "r");
    }

    function test_I02_SecondsUntilBelowZero() public view {
        assertEq(ledger.secondsUntilBelow(_h(bob), 0), type(uint256).max);
    }

    // ----------------------------------------------------------- publisher
    function test_BrokenPublisherNeverBlocksPenalty() public {
        RevertingPublisher rp = new RevertingPublisher();
        vm.prank(admin);
        ledger.setPublisher(rp);
        _wrong(_bobValidates(), false);
        assertEq(ledger.balanceOf(bob), 1);

        GasBurningPublisher gp = new GasBurningPublisher();
        vm.prank(admin);
        ledger.setPublisher(gp);
        _wrong(_bobValidates(), false);
        assertEq(ledger.balanceOf(bob), 2);
        ledger.republish(_h(bob)); // permissionless repair never reverts either (L-03)
    }

    // -------------------------------------------------------------- config
    function test_BadConfigRejected() public {
        PenaltyLedger.Config memory c;
        PenaltyLedger.Config[6] memory bad;
        c = _cfg(); c.base = 0; bad[0] = c;
        c = _cfg(); c.fadePeriod = 0; bad[1] = c;
        c = _cfg(); c.stage2At = 600; bad[2] = c; // stage2 > stage3
        c = _cfg(); c.stage3At = 2000; bad[3] = c; // stage3 > cap
        c = _cfg(); c.escalationBps = 50_001; bad[4] = c;
        c = _cfg(); c.majorMultiplier = 0; bad[5] = c;
        vm.startPrank(admin);
        for (uint256 i; i < bad.length; ++i) {
            vm.expectRevert(PenaltyLedger.BadConfig.selector);
            ledger.setConfig(bad[i]);
        }
        vm.stopPrank();
    }

    function test_TokenURI() public {
        _wrong(_bobValidates(), false);
        bytes memory u = bytes(ledger.tokenURI(1));
        bytes memory prefix = bytes("data:application/json;base64,");
        for (uint256 i; i < prefix.length; ++i) assertEq(u[i], prefix[i]);
    }
}
