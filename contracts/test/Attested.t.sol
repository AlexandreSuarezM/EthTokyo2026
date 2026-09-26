// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {Base} from "./Base.t.sol";
import {HumanRegistry} from "../src/HumanRegistry.sol";
import {PermissionRegistry} from "../src/PermissionRegistry.sol";
import {ValidationReceipts} from "../src/ValidationReceipts.sol";
import {HumanProof} from "../src/interfaces/IHumanVerifier.sol";

/// @notice Attested enrollment and key rotation (World ID 4.0 verified off-chain, co-signed by the
///         backend) and the Selfie credential cap on REPO_TIER.
contract AttestedTest is Base {
    uint256 attesterPk = 0xA77E57;
    uint256 fakeAttesterPk = 0xBAD;
    address attester;

    uint256 davePk = 0xDA7E;
    uint256 erinPk = 0xE121;
    uint256 frankPk = 0xF2A2C;
    address dave;
    address erin;
    address frank;

    bytes32 constant H_DAVE = keccak256("world-id-4:dave");
    bytes32 constant H_SAM = keccak256("world-id-4:sam");
    bytes32 constant SESSION = keccak256("verify-result:session-1");

    uint8 ORB;
    uint8 SELFIE;

    function setUp() public override {
        super.setUp();
        attester = vm.addr(attesterPk);
        dave = vm.addr(davePk);
        erin = vm.addr(erinPk);
        frank = vm.addr(frankPk);
        ORB = humans.LEVEL_ORB();
        SELFIE = humans.LEVEL_SELFIE();
        vm.prank(admin);
        humans.setAttester(attester);
    }

    // ------------------------------------------------------------ helpers
    function _enrollSig(uint256 pk, address account, bytes32 human, bytes32 ref, uint8 level, uint256 deadline)
        internal
        view
        returns (bytes memory)
    {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, humans.enrollDigest(account, human, ref, level, deadline));
        return abi.encodePacked(r, s, v);
    }

    function _rotateSig(uint256 pk, address account, bytes32 human, bytes32 ref, uint256 deadline)
        internal
        view
        returns (bytes memory)
    {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, humans.rotateDigest(account, human, ref, deadline));
        return abi.encodePacked(r, s, v);
    }

    function _enrollAttested(address who, bytes32 human, uint8 level) internal {
        uint256 deadline = block.timestamp + 10 minutes;
        bytes memory sig = _enrollSig(attesterPk, who, human, SESSION, level, deadline);
        vm.prank(who);
        humans.enrollAttested(human, SESSION, level, deadline, sig);
    }

    function _rotateAttested(address to, bytes32 human, bytes32 ref) internal returns (bytes memory sig) {
        uint256 deadline = block.timestamp + 10 minutes;
        sig = _rotateSig(attesterPk, to, human, ref, deadline);
        vm.prank(to);
        humans.rotateKeyAttested(human, ref, deadline, sig);
    }

    /// Selfie human "sam" (= dave's key) who may validate tier-1 repos.
    function _selfieValidator() internal returns (bytes32 human) {
        _enrollAttested(dave, H_SAM, SELFIE);
        human = H_SAM;
        vm.startPrank(admin);
        _give(human, perms.REPO_TIER(), 1);
        _give(human, perms.APPROVE_DEPTH(), 400);
        vm.stopPrank();
    }

    // ================================================== attested enrollment
    function test_AttestedEnrollHappyPath() public {
        uint256 deadline = block.timestamp + 10 minutes;
        bytes memory sig = _enrollSig(attesterPk, dave, H_DAVE, SESSION, ORB, deadline);
        vm.expectEmit(true, true, false, true, address(humans));
        emit HumanRegistry.EnrolledAttested(H_DAVE, dave, ORB, SESSION);
        vm.prank(dave);
        humans.enrollAttested(H_DAVE, SESSION, ORB, deadline, sig);

        assertEq(humans.humanOf(dave), H_DAVE);
        assertEq(humans.accountOf(H_DAVE), dave);
        assertEq(humans.levelOf(H_DAVE), ORB);
        assertEq(humans.sessionRefOf(H_DAVE), SESSION);
        assertTrue(humans.digestUsed(humans.enrollDigest(dave, H_DAVE, SESSION, ORB, deadline)));
        assertEq(humans.requireHuman(dave), H_DAVE);
    }

    function test_AttestedEnrollWrongAttesterReverts() public {
        uint256 deadline = block.timestamp + 10 minutes;
        bytes memory sig = _enrollSig(fakeAttesterPk, dave, H_DAVE, SESSION, ORB, deadline);
        vm.prank(dave);
        vm.expectRevert(HumanRegistry.BadAttestation.selector);
        humans.enrollAttested(H_DAVE, SESSION, ORB, deadline, sig);
    }

    function test_AttestedEnrollIsBoundToSender() public {
        uint256 deadline = block.timestamp + 10 minutes;
        bytes memory sig = _enrollSig(attesterPk, dave, H_DAVE, SESSION, ORB, deadline);
        vm.prank(mal); // front-runs dave's transaction with dave's attestation
        vm.expectRevert(HumanRegistry.BadAttestation.selector);
        humans.enrollAttested(H_DAVE, SESSION, ORB, deadline, sig);
    }

    function test_AttestedEnrollIsBoundToChain() public {
        uint256 deadline = block.timestamp + 10 minutes;
        bytes memory sig = _enrollSig(attesterPk, dave, H_DAVE, SESSION, ORB, deadline);
        vm.chainId(block.chainid + 1); // same contract address on another chain (e.g. a fork)
        vm.prank(dave);
        vm.expectRevert(HumanRegistry.BadAttestation.selector);
        humans.enrollAttested(H_DAVE, SESSION, ORB, deadline, sig);
    }

    function test_AttestedEnrollTamperedLevelReverts() public {
        uint256 deadline = block.timestamp + 10 minutes;
        bytes memory sig = _enrollSig(attesterPk, dave, H_DAVE, SESSION, SELFIE, deadline);
        vm.prank(dave); // claims Orb with a Selfie attestation
        vm.expectRevert(HumanRegistry.BadAttestation.selector);
        humans.enrollAttested(H_DAVE, SESSION, ORB, deadline, sig);
    }

    function test_AttestedEnrollExpiredReverts() public {
        uint256 deadline = block.timestamp + 10 minutes;
        bytes memory sig = _enrollSig(attesterPk, dave, H_DAVE, SESSION, ORB, deadline);
        vm.warp(deadline + 1);
        vm.prank(dave);
        vm.expectRevert(HumanRegistry.Expired.selector);
        humans.enrollAttested(H_DAVE, SESSION, ORB, deadline, sig);
    }

    function test_AttestedEnrollReplayReverts() public {
        uint256 deadline = block.timestamp + 10 minutes;
        bytes memory sig = _enrollSig(attesterPk, dave, H_DAVE, SESSION, ORB, deadline);
        vm.prank(dave);
        humans.enrollAttested(H_DAVE, SESSION, ORB, deadline, sig);

        vm.prank(dave);
        vm.expectRevert(HumanRegistry.AlreadyEnrolled.selector);
        humans.enrollAttested(H_DAVE, SESSION, ORB, deadline, sig);

        // dave moves to a new key; the old enrollment attestation still can't bring the old key back
        _rotateAttested(erin, H_DAVE, keccak256("rotate-1"));
        vm.prank(dave);
        vm.expectRevert(HumanRegistry.HumanAlreadyHasAccount.selector);
        humans.enrollAttested(H_DAVE, SESSION, ORB, deadline, sig);
    }

    function test_SecondAccountForSameHumanReverts() public {
        _enrollAttested(dave, H_DAVE, ORB);
        uint256 deadline = block.timestamp + 10 minutes;
        bytes memory sig = _enrollSig(attesterPk, erin, H_DAVE, SESSION, ORB, deadline);
        vm.prank(erin);
        vm.expectRevert(HumanRegistry.HumanAlreadyHasAccount.selector);
        humans.enrollAttested(H_DAVE, SESSION, ORB, deadline, sig);
    }

    function test_EnrolledAccountCannotEnrollAgain() public {
        _enrollAttested(dave, H_DAVE, ORB);
        uint256 deadline = block.timestamp + 10 minutes;
        bytes32 other = keccak256("world-id-4:someone-else");
        bytes memory sig = _enrollSig(attesterPk, dave, other, SESSION, ORB, deadline);
        vm.prank(dave);
        vm.expectRevert(HumanRegistry.AlreadyEnrolled.selector);
        humans.enrollAttested(other, SESSION, ORB, deadline, sig);
    }

    function test_AttestedEnrollInputGuards() public {
        uint256 deadline = block.timestamp + 10 minutes;
        for (uint8 level; level < 6; ++level) {
            if (level == ORB || level == SELFIE || level == humans.LEVEL_SIMULATED()) continue;
            bytes memory sig = _enrollSig(attesterPk, dave, H_DAVE, SESSION, level, deadline);
            vm.prank(dave);
            vm.expectRevert(HumanRegistry.BadLevel.selector);
            humans.enrollAttested(H_DAVE, SESSION, level, deadline, sig);
        }

        bytes memory zeroHuman = _enrollSig(attesterPk, dave, bytes32(0), SESSION, ORB, deadline);
        vm.prank(dave);
        vm.expectRevert(HumanRegistry.UnknownHuman.selector);
        humans.enrollAttested(bytes32(0), SESSION, ORB, deadline, zeroHuman);

        bytes memory zeroRef = _enrollSig(attesterPk, dave, H_DAVE, bytes32(0), ORB, deadline);
        vm.prank(dave);
        vm.expectRevert(HumanRegistry.BadAttestation.selector);
        humans.enrollAttested(H_DAVE, bytes32(0), ORB, deadline, zeroRef);
    }

    function test_OnlyAdminSetsAttester() public {
        bytes32 adminRole = humans.DEFAULT_ADMIN_ROLE();
        vm.prank(mal);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, mal, adminRole)
        );
        humans.setAttester(mal);
    }

    /// L-05: the on-chain and attested paths derive humanId differently (nullifier vs. backend id),
    /// so only one may be open at a time, or one person could hold an account in each.
    function test_L05_EnrollModesAreExclusive() public {
        HumanProof memory p = _proof(humans.enrollSignal(dave), 77);
        vm.prank(dave);
        vm.expectRevert(HumanRegistry.AttesterMode.selector);
        humans.enroll(p);

        HumanProof memory r = _proof(humans.rotateSignal(erin), 2); // bob's nullifier
        vm.prank(erin);
        vm.expectRevert(HumanRegistry.AttesterMode.selector);
        humans.rotateKey(r);

        vm.prank(admin);
        humans.setAttester(address(0)); // back to on-chain mode
        uint256 deadline = block.timestamp + 10 minutes;
        bytes memory sig = _enrollSig(attesterPk, dave, H_DAVE, SESSION, ORB, deadline);
        vm.prank(dave);
        vm.expectRevert(HumanRegistry.OnChainMode.selector);
        humans.enrollAttested(H_DAVE, SESSION, ORB, deadline, sig);

        vm.prank(dave);
        humans.enroll(p); // the on-chain path still works in its own mode
        assertEq(humans.levelOf(bytes32(uint256(77))), ORB);
    }

    function test_OnChainEnrollRecordsOrbLevel() public view {
        assertEq(humans.levelOf(_h(bob)), ORB);
        assertEq(humans.sessionRefOf(_h(bob)), bytes32(0));
    }

    // ===================================================== attested rotation
    function test_AttestedRotationKeepsLevelScoreAndPermissions() public {
        bytes32 sam = _selfieValidator();
        uint256 id = _validate(davePk, REPO_WEB, _nextCommit(), 1);
        _wrong(id, false);
        uint256 score = ledger.scoreOf(sam);
        assertEq(score, 100 * WAD);

        bytes32 ref2 = keccak256("rotate-1");
        _rotateAttested(erin, sam, ref2);

        assertEq(humans.humanOf(dave), bytes32(0));
        assertEq(humans.humanOf(erin), sam);
        assertEq(humans.accountOf(sam), erin);
        assertEq(humans.levelOf(sam), SELFIE); //  level follows the human
        assertEq(humans.sessionRefOf(sam), ref2);
        assertEq(ledger.scoreOf(sam), score); //  score follows the human
        assertEq(perms.activeValue(sam, perms.REPO_TIER()), 1); // Selfie cap still applies

        // the new key validates within the cap; the old key is no longer a human
        _validate(erinPk, REPO_WEB, _nextCommit(), 2);
        ValidationReceipts.HumanApproval memory a = _approval(REPO_WEB, _nextCommit(), 120, 3);
        bytes memory sig = _sign(davePk, a);
        HumanProof memory none;
        vm.expectRevert(ValidationReceipts.BadSignature.selector);
        receipts.validate(a, sig, none, _noAtt());
    }

    function test_AttestedRotationReplayReverts() public {
        _enrollAttested(dave, H_DAVE, ORB);
        bytes memory toErin = _rotateAttested(erin, H_DAVE, keccak256("rotate-1"));
        _rotateAttested(frank, H_DAVE, keccak256("rotate-2"));

        // erin is free again; without the used-digest set the old signature would move the human back
        uint256 deadline = block.timestamp + 10 minutes;
        vm.prank(erin);
        vm.expectRevert(HumanRegistry.DigestUsed.selector);
        humans.rotateKeyAttested(H_DAVE, keccak256("rotate-1"), deadline, toErin);
        assertEq(humans.accountOf(H_DAVE), frank);
    }

    function test_AttestedRotationGuards() public {
        _enrollAttested(dave, H_DAVE, ORB);
        uint256 deadline = block.timestamp + 10 minutes;
        bytes32 ref = keccak256("rotate-1");

        bytes memory wrong = _rotateSig(fakeAttesterPk, erin, H_DAVE, ref, deadline);
        vm.prank(erin);
        vm.expectRevert(HumanRegistry.BadAttestation.selector);
        humans.rotateKeyAttested(H_DAVE, ref, deadline, wrong);

        bytes memory sig = _rotateSig(attesterPk, erin, H_DAVE, ref, deadline);
        vm.prank(mal); // not the account named in the attestation
        vm.expectRevert(HumanRegistry.BadAttestation.selector);
        humans.rotateKeyAttested(H_DAVE, ref, deadline, sig);

        bytes memory toBob = _rotateSig(attesterPk, bob, H_DAVE, ref, deadline);
        vm.prank(bob); // already another human's key
        vm.expectRevert(HumanRegistry.AlreadyEnrolled.selector);
        humans.rotateKeyAttested(H_DAVE, ref, deadline, toBob);

        bytes32 nobody = keccak256("world-id-4:nobody");
        bytes memory unknown = _rotateSig(attesterPk, erin, nobody, ref, deadline);
        vm.prank(erin);
        vm.expectRevert(HumanRegistry.UnknownHuman.selector);
        humans.rotateKeyAttested(nobody, ref, deadline, unknown);

        vm.warp(deadline + 1);
        vm.prank(erin);
        vm.expectRevert(HumanRegistry.Expired.selector);
        humans.rotateKeyAttested(H_DAVE, ref, deadline, sig);
    }

    // ======================================================= Selfie tier cap
    function test_SelfieCapEnforcedInValidate() public {
        _selfieValidator();
        _validate(davePk, REPO_WEB, _nextCommit(), 1); // tier 1: within the cap

        ValidationReceipts.HumanApproval memory a = _approval(REPO_PAY, _nextCommit(), 120, 2);
        bytes memory sig = _sign(davePk, a);
        HumanProof memory none;
        bytes memory err = abi.encodeWithSelector(ValidationReceipts.InsufficientPermission.selector, perms.REPO_TIER());
        vm.prank(relayer); // tier 2 is above the Selfie cap
        vm.expectRevert(err);
        receipts.validate(a, sig, none, _noAtt());
    }

    function test_SelfieCapLoweredTakesEffectAtOnce() public {
        bytes32 sam = _selfieValidator();
        vm.prank(admin);
        perms.setPolicy(PermissionRegistry.Policy(2, false, DAY, 90 * DAY, 2, 0));
        bytes32 tier = perms.REPO_TIER();
        assertEq(perms.activeValue(sam, tier), 0);
        assertEq(perms.grantOf(sam, tier).value, 1); // the grant itself is untouched

        ValidationReceipts.HumanApproval memory a = _approval(REPO_WEB, _nextCommit(), 120, 1);
        bytes memory sig = _sign(davePk, a);
        HumanProof memory none;
        bytes memory err = abi.encodeWithSelector(ValidationReceipts.InsufficientPermission.selector, perms.REPO_TIER());
        vm.prank(relayer);
        vm.expectRevert(err);
        receipts.validate(a, sig, none, _noAtt());
    }

    function test_GrantAboveSelfieCapReverts() public {
        bytes32 sam = _selfieValidator();
        bytes32 tier = perms.REPO_TIER();

        vm.prank(admin);
        vm.expectRevert(PermissionRegistry.AboveSelfieCap.selector);
        perms.grant(sam, tier, 2, 365 * DAY);

        vm.prank(carol); // a human sponsor holding tier 3 hits the same cap
        vm.expectRevert(PermissionRegistry.AboveSelfieCap.selector);
        perms.grant(sam, tier, 3, 365 * DAY);

        bytes32[] memory ps = new bytes32[](1);
        uint64[] memory vs = new uint64[](1);
        ps[0] = tier;
        vs[0] = 2;
        vm.startPrank(admin);
        perms.definePreset(keccak256("senior"), ps, vs, 30 * DAY);
        vm.expectRevert(PermissionRegistry.AboveSelfieCap.selector);
        perms.applyPreset(sam, keccak256("senior"));
        vm.stopPrank();
    }

    function test_OrbHumanIsNotCapped() public {
        _enrollAttested(dave, H_DAVE, ORB);
        bytes32 tier = perms.REPO_TIER();
        vm.prank(admin);
        perms.grant(H_DAVE, tier, 3, 365 * DAY);
        assertEq(perms.activeValue(H_DAVE, tier), 3);
        assertEq(perms.activeValue(_h(bob), tier), 2); // on-chain (Orb) human unchanged
    }

    function testFuzz_SelfieTierNeverAboveCap(uint64 granted, uint8 capAtGrant, uint8 capLater) public {
        _enrollAttested(dave, H_SAM, SELFIE);
        bytes32 tier = perms.REPO_TIER();
        vm.startPrank(admin);
        perms.setPolicy(PermissionRegistry.Policy(2, false, DAY, 90 * DAY, 2, capAtGrant));
        if (granted > capAtGrant) {
            vm.expectRevert(PermissionRegistry.AboveSelfieCap.selector);
            perms.grant(H_SAM, tier, granted, 365 * DAY);
            granted = capAtGrant;
        }
        perms.grant(H_SAM, tier, granted, 365 * DAY);
        perms.setPolicy(PermissionRegistry.Policy(2, false, DAY, 90 * DAY, 2, capLater));
        vm.stopPrank();

        uint64 v = perms.activeValue(H_SAM, tier);
        assertLe(v, capLater);
        assertEq(v, granted < capLater ? granted : capLater);
    }
}
