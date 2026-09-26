// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {Base} from "./Base.t.sol";
import {RewardToken} from "../src/RewardToken.sol";
import {Bounty} from "../src/Bounty.sol";

/// @notice RewardToken (soulbound, shared cooldown, slash) + Bounty (code, +1 per reviewed sample,
///         qualify at 5, equal split, refund if nobody qualified).
contract BountyTest is Base {
    RewardToken token;
    Bounty bounty;
    Bounty bounty2;
    address judge = makeAddr("judge");
    uint64 constant COOLDOWN = 30;
    bytes32 constant REASON = keccak256("approved failing code");
    uint256 internal _t;
    uint256 internal _sample;

    function setUp() public override {
        super.setUp();
        token = new RewardToken(admin, COOLDOWN);
        bounty = new Bounty(humans, token, admin, keccak256("hello-world"), "ipfs://hello", uint64(block.timestamp + 1), 5);
        bounty2 = new Bounty(humans, token, admin, keccak256("other"), "ipfs://other", uint64(block.timestamp + 1), 5);
        vm.startPrank(admin);
        token.grantRole(token.MINTER_ROLE(), address(bounty));
        token.grantRole(token.MINTER_ROLE(), address(bounty2));
        token.grantRole(token.JUDGE_ROLE(), judge);
        bounty.grantRole(bounty.JUDGE_ROLE(), judge);
        bounty2.grantRole(bounty2.JUDGE_ROLE(), judge);
        vm.stopPrank();
        vm.deal(admin, 1 ether);
        vm.prank(admin);
        bounty.fund{value: 0.01 ether}();
        _t = block.timestamp;
    }

    function _award(Bounty b, address who) internal returns (uint32) {
        bytes32 h = _h(who);
        bytes32 id = keccak256(abi.encode("sample", ++_sample));
        vm.prank(judge);
        return b.award(h, id);
    }

    function _earn(address who, uint256 n) internal {
        for (uint256 i; i < n; ++i) {
            _award(bounty, who);
            _t += COOLDOWN;
            vm.warp(_t); // absolute: via_ir may cache block.timestamp across warps
        }
    }

    function test_Bounty_OneTokenPerSampleOnce() public {
        assertEq(_award(bounty, bob), 1);
        bytes32 h = _h(bob);
        bytes32 id = keccak256(abi.encode("sample", _sample)); // the same sample again
        vm.warp(_t + COOLDOWN);
        vm.prank(judge);
        vm.expectRevert(Bounty.AlreadyAwarded.selector);
        bounty.award(h, id);
    }

    function test_Bounty_SharedCooldownAcrossBounties() public {
        _award(bounty, bob);
        bytes32 h = _h(bob);
        bytes32 id = keccak256("sample on bounty 2");
        vm.prank(judge); // another bounty, same token: still too fast
        vm.expectRevert(abi.encodeWithSelector(RewardToken.CooldownActive.selector, uint64(_t + COOLDOWN)));
        bounty2.award(h, id);
        assertEq(token.secondsUntilNext(h), COOLDOWN);

        vm.warp(_t + COOLDOWN);
        vm.prank(judge);
        bounty2.award(h, id);
        assertEq(token.balanceOf(h), 2);
    }

    function test_Bounty_OnlyJudgeAwardsOnlyBountiesMint() public {
        bytes32 h = _h(bob);
        bytes32 role = bounty.JUDGE_ROLE();
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, bob, role));
        bounty.award(h, keccak256("x"));

        bytes32 minter = token.MINTER_ROLE();
        vm.prank(judge);
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, judge, minter));
        token.mint(h);
    }

    function test_Bounty_UnenrolledGetsNothing() public {
        vm.prank(judge);
        vm.expectRevert(Bounty.NotEnrolled.selector);
        bounty.award(keccak256("nobody"), keccak256("s"));
    }

    function test_Bounty_SlashByJudgeOrOwnerOnly_KeepsSeat() public {
        _earn(bob, 5);
        vm.prank(bob);
        bounty.optIn();
        bytes32 h = _h(bob);

        vm.prank(alice);
        vm.expectRevert();
        token.slash(h, REASON);
        vm.prank(judge);
        vm.expectRevert(RewardToken.ReasonRequired.selector);
        token.slash(h, bytes32(0));

        vm.prank(judge);
        token.slash(h, REASON);
        assertEq(token.balanceOf(h), 0);
        assertTrue(bounty.qualified(h)); // the seat stays

        vm.prank(admin);
        token.slash(h, REASON); // the owner can slash too
    }

    function test_Bounty_QualifyAtFive() public {
        _earn(bob, 4);
        vm.prank(bob);
        vm.expectRevert(Bounty.NotEnoughTokens.selector);
        bounty.optIn();
        _earn(bob, 1);
        vm.prank(bob);
        bounty.optIn();
        vm.prank(bob);
        vm.expectRevert(Bounty.AlreadyQualified.selector);
        bounty.optIn();
        vm.prank(mal);
        vm.expectRevert(Bounty.NotEnrolled.selector);
        bounty.optIn();
    }

    function test_Bounty_EqualSplitAmongQualified() public {
        _earn(bob, 5);
        vm.prank(bob);
        bounty.optIn();
        _earn(carol, 5);
        vm.prank(carol);
        bounty.optIn();

        uint256 b0 = bob.balance;
        vm.prank(bob);
        bounty.claim();
        assertEq(bob.balance - b0, 0.005 ether);
        vm.prank(bob);
        vm.expectRevert(Bounty.AlreadyClaimed.selector);
        bounty.claim();

        uint256 c0 = carol.balance;
        vm.prank(carol);
        bounty.claim();
        assertEq(carol.balance - c0, 0.005 ether);
        assertEq(address(bounty).balance, 0);

        vm.prank(alice);
        vm.expectRevert(Bounty.NotQualified.selector);
        bounty.claim();
        vm.prank(admin);
        vm.expectRevert(Bounty.SomeoneQualified.selector);
        bounty.withdraw(payable(admin));
    }

    function test_Bounty_ClaimOpensAtDeadline() public {
        Bounty later = new Bounty(humans, token, admin, keccak256("c"), "u", uint64(block.timestamp + 1 days), 1);
        bytes32 role = token.MINTER_ROLE();
        bytes32 judgeRole = later.JUDGE_ROLE();
        vm.startPrank(admin);
        token.grantRole(role, address(later));
        later.grantRole(judgeRole, judge);
        vm.stopPrank();
        bytes32 h = _h(bob);
        vm.prank(judge);
        later.award(h, keccak256("s1"));
        vm.prank(bob);
        later.optIn();
        vm.prank(bob);
        vm.expectRevert(Bounty.ClaimNotOpen.selector);
        later.claim();
        vm.prank(admin);
        vm.expectRevert(Bounty.ClaimNotOpen.selector);
        later.withdraw(payable(admin));
    }

    function test_Bounty_NobodyQualifiedOwnerRefund() public {
        _earn(bob, 2);
        uint256 a0 = admin.balance;
        vm.prank(admin);
        bounty.withdraw(payable(admin));
        assertEq(admin.balance - a0, 0.01 ether);

        bytes32 role = bounty.DEFAULT_ADMIN_ROLE();
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, bob, role));
        bounty.withdraw(payable(bob));
    }

    function test_Bounty_BadConfig() public {
        vm.expectRevert(Bounty.BadConfig.selector);
        new Bounty(humans, token, admin, bytes32(0), "u", 0, 5);
        vm.expectRevert(Bounty.BadConfig.selector);
        new Bounty(humans, token, admin, keccak256("c"), "u", 0, 0);
    }
}
