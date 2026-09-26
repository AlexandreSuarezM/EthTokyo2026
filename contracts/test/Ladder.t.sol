// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {Base} from "./Base.t.sol";
import {PenaltyLedger} from "../src/PenaltyLedger.sol";
import {ValidationReceipts} from "../src/ValidationReceipts.sol";
import {HumanProof} from "../src/interfaces/IHumanVerifier.sol";

/// @notice Demo ladder (environments/demo.json): count-based weights, permanent ban at 3 tokens,
///         and the judge (a server, not an enrolled human) lifting restrictions early.
contract LadderTest is Base {
    address judge = makeAddr("judge"); // the relayer in the demo: oracle + judge
    bytes32 constant REASON = keccak256("judge: demo lift");

    function setUp() public override {
        super.setUp();
        vm.startPrank(admin);
        ledger.setConfig(
            PenaltyLedger.Config({
                base: 100,
                majorMultiplier: 1,
                escalationBps: 0,
                maxScore: 1000,
                stage2At: 1, // any score = restricted (no AI)
                stage3At: 1000,
                fadePeriod: 300 // 5 minutes
            })
        );
        ledger.setLadder(PenaltyLedger.Ladder({banAtCount: 3, weightByCount: true}));
        ledger.grantRole(ledger.JUDGE_ROLE(), judge);
        receipts.grantRole(receipts.ORACLE_ROLE(), judge);
        vm.stopPrank();
    }

    function _token() internal {
        uint256 id = _bobValidates();
        vm.prank(judge);
        receipts.oraclePenalize(id, EVIDENCE, false);
    }

    function _lift() internal {
        bytes32 h = _h(bob);
        vm.prank(judge);
        ledger.judgeLift(h, REASON);
    }

    function _stage() internal view returns (uint8) {
        return ledger.stageOf(_h(bob));
    }

    function test_Ladder_Token1RestrictsThenJudgeLifts() public {
        _token();
        assertEq(_stage(), 2); // restricted
        assertEq(perms.activeValue(_h(bob), perms.AI_SUBMIT()), 0);

        bytes32 h = _h(bob);
        vm.expectEmit(true, true, false, true, address(ledger));
        emit PenaltyLedger.Forgiven(h, judge, 100 * WAD, 0, REASON);
        _lift();
        assertEq(_stage(), 0); // active again
        assertEq(ledger.balanceOf(bob), 1); // the token stays
        assertEq(ledger.penaltyCount(_h(bob)), 1);
    }

    function test_Ladder_Token1LiftsByItselfAfterFadePeriod() public {
        _token();
        uint256 t0 = block.timestamp;
        vm.warp(t0 + 296); // restricted while the score is >= 1 point (~297 s)
        assertEq(_stage(), 2);
        vm.warp(t0 + 300); // 5 minutes: the score is gone
        assertEq(_stage(), 0);
    }

    function test_Ladder_Token2RestrictsTwiceAsLong() public {
        _token();
        _lift();
        _token(); // weighs 2 x base
        assertEq(_score(bob), 200 * WAD);
        uint256 t0 = block.timestamp; // absolute times: via_ir may cache block.timestamp across warps
        vm.warp(t0 + 300);
        assertEq(_stage(), 2); // still restricted after 5 minutes
        vm.warp(t0 + 600);
        assertEq(_stage(), 0); // free after 10 minutes
    }

    function test_Ladder_ThreeTokensBanForever() public {
        _token();
        _lift();
        _token();
        _lift();
        _token();
        assertEq(_stage(), 3);
        assertTrue(ledger.isBannedForever(_h(bob)));

        vm.warp(block.timestamp + 3650 days); // no fade undoes it
        assertEq(_score(bob), 0);
        assertEq(_stage(), 3);

        ValidationReceipts.HumanApproval memory a = _approval(REPO_WEB, _nextCommit(), 120, 77);
        bytes memory sig = _sign(bobPk, a);
        HumanProof memory none;
        vm.prank(relayer);
        vm.expectRevert(ValidationReceipts.Banned.selector);
        receipts.validate(a, sig, none, _noAtt());
    }

    function test_Ladder_JudgeCannotLiftBan() public {
        _token();
        _token();
        _token();
        bytes32 h = _h(bob);
        vm.prank(judge);
        vm.expectRevert(PenaltyLedger.BannedForever.selector);
        ledger.judgeLift(h, REASON);
        vm.prank(evaluator); // nor the human evaluator: forgiving the score doesn't touch the count
        ledger.forgive(h, 1000 * WAD, REASON);
        assertEq(_stage(), 3);
    }

    function test_Ladder_JudgeLiftGuards() public {
        _token();
        bytes32 h = _h(bob);
        vm.prank(judge);
        vm.expectRevert(PenaltyLedger.ReasonRequired.selector);
        ledger.judgeLift(h, bytes32(0));

        bytes32 role = ledger.JUDGE_ROLE();
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, relayer, role));
        ledger.judgeLift(h, REASON);

        vm.prank(admin); // misconfiguration: the validator holds the role
        ledger.grantRole(role, bob);
        vm.prank(bob);
        vm.expectRevert(PenaltyLedger.SelfForgiveness.selector);
        ledger.judgeLift(h, REASON);
        assertEq(_stage(), 2);
    }

    function test_Ladder_OffKeepsScoreBasedBehaviour() public {
        vm.startPrank(admin);
        ledger.setLadder(PenaltyLedger.Ladder({banAtCount: 0, weightByCount: false}));
        ledger.setConfig(_cfg()); // default rulebook: +100% escalation
        vm.stopPrank();
        _token();
        _token();
        _token();
        assertEq(_score(bob), 700 * WAD); // 100, +200, +400: escalation as before
        assertEq(ledger.penaltyCount(_h(bob)), 3);
        assertFalse(ledger.isBannedForever(_h(bob)));
    }
}
