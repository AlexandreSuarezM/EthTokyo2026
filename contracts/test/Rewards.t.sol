// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {Base} from "./Base.t.sol";
import {ChallengeRewards} from "../src/ChallengeRewards.sol";

/// @notice Reward points (soulbound, slow: one per cooldown) and the prize pool (equal split after the
///         deadline among humans who opted in with >= 5 points; nobody -> owner withdraws).
contract RewardsTest is Base {
    ChallengeRewards rewards;
    address judge = makeAddr("judge");
    uint64 constant COOLDOWN = 1 hours;
    bytes32 constant REASON = keccak256("approved wrong code");
    uint64 deadlineAt;

    function setUp() public override {
        super.setUp();
        deadlineAt = uint64(block.timestamp + 1 days);
        rewards = new ChallengeRewards(humans, receipts, admin, deadlineAt, COOLDOWN, 5);
        vm.startPrank(admin);
        rewards.grantRole(rewards.JUDGE_ROLE(), judge);
        vm.deal(admin, 10 ether);
        rewards.fund{value: 1 ether}();
        vm.stopPrank();
    }

    uint256 internal _t; // absolute clock: via_ir may cache block.timestamp across warps

    function _pointFor(uint256 pk) internal returns (uint256 id) {
        id = _validate(pk, REPO_WEB, _nextCommit(), _nonce++);
        bytes32 h = _h(vm.addr(pk));
        vm.prank(judge);
        rewards.award(h, id);
    }

    function _earn(uint256 pk, uint256 n) internal {
        if (_t == 0) _t = block.timestamp;
        for (uint256 i; i < n; ++i) {
            _pointFor(pk);
            _t += COOLDOWN;
            vm.warp(_t);
        }
    }

    function test_Rewards_OnePointPerCorrectReceiptOnce() public {
        uint256 id = _pointFor(bobPk);
        assertEq(rewards.pointsOf(_h(bob)), 1);
        bytes32 h = _h(bob);
        vm.prank(judge);
        vm.expectRevert(ChallengeRewards.AlreadyRewarded.selector);
        rewards.award(h, id);
    }

    function test_Rewards_CooldownMakesPointsSlow() public {
        uint256 t0 = block.timestamp;
        _pointFor(bobPk);
        uint256 id2 = _validate(bobPk, REPO_WEB, _nextCommit(), _nonce++);
        bytes32 h = _h(bob);
        vm.prank(judge);
        vm.expectRevert(abi.encodeWithSelector(ChallengeRewards.CooldownActive.selector, uint64(t0 + COOLDOWN)));
        rewards.award(h, id2);
        assertEq(rewards.secondsUntilNextPoint(h), COOLDOWN);

        vm.warp(t0 + COOLDOWN);
        vm.prank(judge);
        rewards.award(h, id2); // the same receipt earns it once the cooldown is over
        assertEq(rewards.pointsOf(h), 2);
    }

    function test_Rewards_OnlyTheValidatorsStandingReceipt() public {
        uint256 id = _validate(bobPk, REPO_WEB, _nextCommit(), _nonce++);
        bytes32 carolH = _h(carol);
        vm.prank(judge);
        vm.expectRevert(ChallengeRewards.NotTheValidator.selector);
        rewards.award(carolH, id); // not carol's receipt

        vm.prank(judge);
        vm.expectRevert(ChallengeRewards.NotTheValidator.selector);
        rewards.award(carolH, 999); // unknown receipt

        _wrong(id, false); // ruled wrong (Missed): no reward
        bytes32 bobH = _h(bob);
        vm.prank(judge);
        vm.expectRevert(ChallengeRewards.NotStanding.selector);
        rewards.award(bobH, id);
    }

    function test_Rewards_OnlyJudgeAwards() public {
        uint256 id = _validate(bobPk, REPO_WEB, _nextCommit(), _nonce++);
        bytes32 h = _h(bob);
        bytes32 role = rewards.JUDGE_ROLE();
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, bob, role));
        rewards.award(h, id);
    }

    function test_Rewards_SlashByJudgeOrOwnerOnly() public {
        _earn(bobPk, 2);
        bytes32 h = _h(bob);
        vm.prank(alice);
        vm.expectRevert();
        rewards.slash(h, REASON);
        vm.prank(judge);
        vm.expectRevert(ChallengeRewards.ReasonRequired.selector);
        rewards.slash(h, bytes32(0));

        vm.prank(judge);
        rewards.slash(h, REASON);
        assertEq(rewards.pointsOf(h), 0);
        _earn(bobPk, 1);
        vm.prank(admin); // the owner can slash too
        rewards.slash(h, REASON);
        assertEq(rewards.pointsOf(h), 0);
    }

    function test_Rewards_OptInNeedsFivePointsBeforeDeadline() public {
        _earn(bobPk, 4);
        vm.prank(bob);
        vm.expectRevert(ChallengeRewards.NotEnoughPoints.selector);
        rewards.optIn();
        _earn(bobPk, 1);
        vm.prank(bob);
        rewards.optIn();
        vm.prank(bob);
        vm.expectRevert(ChallengeRewards.AlreadyOptedIn.selector);
        rewards.optIn();

        vm.prank(mal); // not enrolled
        vm.expectRevert(ChallengeRewards.NotEnrolled.selector);
        rewards.optIn();
    }

    function test_Rewards_EqualSplitAfterDeadline_SlashKeepsPrize() public {
        _earn(bobPk, 5);
        vm.prank(bob);
        rewards.optIn();
        _t = 0;
        _earn(carolPk, 5);
        vm.prank(carol);
        rewards.optIn();

        bytes32 h = _h(bob);
        vm.prank(judge); // slashed after opting in: points gone, prize share kept
        rewards.slash(h, REASON);
        assertEq(rewards.pointsOf(h), 0);

        vm.prank(bob);
        vm.expectRevert(ChallengeRewards.DeadlineNotReached.selector);
        rewards.claim();

        vm.warp(uint256(deadlineAt) + 1);
        uint256 before = bob.balance;
        vm.prank(bob);
        rewards.claim();
        assertEq(bob.balance - before, 0.5 ether);
        vm.prank(bob);
        vm.expectRevert(ChallengeRewards.AlreadyClaimed.selector);
        rewards.claim();

        vm.prank(carol);
        rewards.claim();
        assertEq(address(rewards).balance, 0);

        vm.prank(alice); // never opted in
        vm.expectRevert(ChallengeRewards.NotOptedIn.selector);
        rewards.claim();

        vm.prank(admin); // someone qualified: the owner can't take the pool
        vm.expectRevert(ChallengeRewards.SomeoneOptedIn.selector);
        rewards.withdraw(payable(admin));
    }

    function test_Rewards_NobodyQualifiesOwnerGetsFundsBack() public {
        _earn(bobPk, 3);
        vm.prank(admin);
        vm.expectRevert(ChallengeRewards.DeadlineNotReached.selector);
        rewards.withdraw(payable(admin));

        vm.warp(uint256(deadlineAt) + 1);
        uint256 before = admin.balance;
        vm.prank(admin);
        rewards.withdraw(payable(admin));
        assertEq(admin.balance - before, 1 ether);

        bytes32 role = rewards.DEFAULT_ADMIN_ROLE();
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, bob, role));
        rewards.withdraw(payable(bob));
    }

    function test_Rewards_NothingAfterDeadline() public {
        uint256 id = _validate(bobPk, REPO_WEB, _nextCommit(), _nonce++);
        vm.warp(uint256(deadlineAt) + 1);
        bytes32 h = _h(bob);
        vm.prank(judge);
        vm.expectRevert(ChallengeRewards.DeadlinePassed.selector);
        rewards.award(h, id);
        vm.prank(admin);
        vm.expectRevert(ChallengeRewards.DeadlinePassed.selector);
        rewards.fund{value: 1}();
    }

    function test_Rewards_BadConfigReverts() public {
        vm.expectRevert(ChallengeRewards.BadConfig.selector);
        new ChallengeRewards(humans, receipts, admin, uint64(block.timestamp), COOLDOWN, 5);
        vm.expectRevert(ChallengeRewards.BadConfig.selector);
        new ChallengeRewards(humans, receipts, admin, uint64(block.timestamp + 1), COOLDOWN, 0);
    }
}
