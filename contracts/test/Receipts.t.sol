// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {Base} from "./Base.t.sol";
import {MockWorldID, MockUSD} from "../src/mocks/Mocks.sol";
import {HumanRegistry} from "../src/HumanRegistry.sol";
import {PermissionRegistry} from "../src/PermissionRegistry.sol";
import {ValidationReceipts} from "../src/ValidationReceipts.sol";
import {HumanProof} from "../src/interfaces/IHumanVerifier.sol";

/// @notice Authentication, receipts, forensics flow and due process.
contract ReceiptsTest is Base {
    // ------------------------------------------------------ authentication
    function test_OneHumanCannotHoldTwoAccounts() public {
        HumanProof memory p = _proof(humans.enrollSignal(mal), 2);
        vm.prank(mal);
        vm.expectRevert(HumanRegistry.HumanAlreadyHasAccount.selector);
        humans.enroll(p);
    }

    function test_EnrollProofCannotBeReplayedForAnotherAccount() public {
        HumanProof memory p = _proof(humans.enrollSignal(alice), 99);
        vm.prank(mal);
        vm.expectRevert(MockWorldID.InvalidProof.selector);
        humans.enroll(p);
    }

    // ------------------------------------------------------------ receipts
    function test_ValidationRecordsReceiptAndMintsNoToken() public {
        uint256 id = _bobValidates();
        ValidationReceipts.Receipt memory r = receipts.receiptOf(id);
        assertEq(r.validatorHuman, _h(bob), "receipt names the signer, not the relayer");
        assertEq(r.submitterHuman, _h(alice));
        assertEq(r.modelId, MODEL);
        assertEq(uint8(r.status), uint8(ValidationReceipts.Status.Valid));
        assertEq(ledger.balanceOf(bob), 0, "no token at validation");
        assertEq(ledger.nextId(), 1);
    }

    function test_UnenrolledSignerCannotRecord() public {
        ValidationReceipts.HumanApproval memory a = _approval(REPO_WEB, keccak256("c"), 10, 1);
        HumanProof memory none;
        bytes memory sig = _sign(malPk, a);
        vm.expectRevert(ValidationReceipts.BadSignature.selector);
        receipts.validate(a, sig, none, _noAtt());
    }

    function test_TamperedApprovalFails() public {
        ValidationReceipts.HumanApproval memory a = _approval(REPO_WEB, keccak256("reviewed"), 10, 1);
        bytes memory sig = _sign(bobPk, a);
        a.commitHash = keccak256("swapped-after-review");
        HumanProof memory none;
        vm.expectRevert(ValidationReceipts.BadSignature.selector);
        receipts.validate(a, sig, none, _noAtt());
    }

    function test_ReplayAndDuplicateBlocked() public {
        ValidationReceipts.HumanApproval memory a = _approval(REPO_WEB, keccak256("c"), 10, 7);
        bytes memory sig = _sign(bobPk, a);
        HumanProof memory none;
        receipts.validate(a, sig, none, _noAtt());
        vm.expectRevert(ValidationReceipts.NonceUsed.selector);
        receipts.validate(a, sig, none, _noAtt());
        a.nonce = 8;
        sig = _sign(bobPk, a);
        vm.expectRevert(ValidationReceipts.AlreadyValidated.selector);
        receipts.validate(a, sig, none, _noAtt());
    }

    function test_ExpiredApprovalRejected() public {
        ValidationReceipts.HumanApproval memory a = _approval(REPO_WEB, keccak256("c"), 10, 1);
        bytes memory sig = _sign(bobPk, a);
        vm.warp(vm.getBlockTimestamp() + 2 hours);
        HumanProof memory none;
        vm.expectRevert(ValidationReceipts.Expired.selector);
        receipts.validate(a, sig, none, _noAtt());
    }

    function test_SelfApprovalFollowsPolicy() public {
        bytes32 tierP = perms.REPO_TIER();
        bytes32 depthP = perms.APPROVE_DEPTH();
        bytes32 aliceH = _h(alice);
        vm.startPrank(admin);
        perms.grant(aliceH, tierP, 1, DAY);
        perms.grant(aliceH, depthP, 500, DAY);
        vm.stopPrank();
        ValidationReceipts.HumanApproval memory a = _approval(REPO_WEB, keccak256("c"), 10, 1);
        HumanProof memory none;
        bytes memory sig = _sign(alicePk, a);
        vm.expectRevert(ValidationReceipts.SelfApproval.selector);
        receipts.validate(a, sig, none, _noAtt());

        vm.prank(admin);
        perms.setPolicy(PermissionRegistry.Policy(2, true, DAY, 90 * DAY, 2, 1)); // your rulebook: always allowed
        receipts.validate(a, sig, none, _noAtt());
    }

    function test_ApproveDepthEnforced() public {
        ValidationReceipts.HumanApproval memory a = _approval(REPO_WEB, keccak256("big"), 401, 1);
        HumanProof memory none;
        bytes memory sig = _sign(bobPk, a);
        vm.expectRevert(
            abi.encodeWithSelector(ValidationReceipts.InsufficientPermission.selector, perms.APPROVE_DEPTH())
        );
        receipts.validate(a, sig, none, _noAtt());
    }

    function test_HighTierNeedsLiveProofFromSameHuman() public {
        bytes32 commit = keccak256("payments-change");
        ValidationReceipts.HumanApproval memory a = _approval(REPO_PAY, commit, 50, 1);
        bytes memory sig = _sign(bobPk, a);
        HumanProof memory wrongHuman = _proof(receipts.liveSignal(commit, bob), 3);
        vm.expectRevert(ValidationReceipts.LiveProofMismatch.selector);
        receipts.validate(a, sig, wrongHuman, _noAtt());
        HumanProof memory wrongCommit = _proof(receipts.liveSignal(keccak256("other"), bob), 2);
        vm.expectRevert(MockWorldID.InvalidProof.selector);
        receipts.validate(a, sig, wrongCommit, _noAtt());
        uint256 id = receipts.validate(a, sig, _proof(receipts.liveSignal(commit, bob), 2), _noAtt());
        assertTrue(receipts.receiptOf(id).liveProof);
    }

    // --------------------------------------------------------- attester mode
    uint256 attesterPk = 0xA77E57;

    function _attest(ValidationReceipts.HumanApproval memory a, bytes32 proofRef, bool presence, uint256 pk)
        internal
        view
        returns (ValidationReceipts.Attestation memory att)
    {
        bytes32 d = receipts.attestationDigest(receipts.approvalDigest(a), proofRef, presence);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, d);
        att = ValidationReceipts.Attestation(proofRef, presence, abi.encodePacked(r, s, v));
    }

    function test_AttesterModeNeedsBothSignatures() public {
        vm.prank(admin);
        receipts.setConfig(30 days, 0, vm.addr(attesterPk));
        HumanProof memory none;
        bytes32 proofRef = keccak256("world-id-4 verify response #1");
        ValidationReceipts.HumanApproval memory a = _approval(REPO_PAY, keccak256("pay"), 20, 1);
        bytes memory sig = _sign(bobPk, a);

        vm.expectRevert(ValidationReceipts.BadAttestation.selector);
        receipts.validate(a, sig, none, _noAtt()); // validator alone

        ValidationReceipts.Attestation memory forged = _attest(a, proofRef, true, 0xBAD);
        vm.expectRevert(ValidationReceipts.BadAttestation.selector);
        receipts.validate(a, sig, none, forged);

        ValidationReceipts.Attestation memory noPresence = _attest(a, proofRef, false, attesterPk);
        vm.expectRevert(ValidationReceipts.LiveProofRequired.selector);
        receipts.validate(a, sig, none, noPresence);

        ValidationReceipts.HumanApproval memory other = _approval(REPO_PAY, keccak256("other"), 20, 2);
        ValidationReceipts.Attestation memory good = _attest(a, proofRef, true, attesterPk);
        bytes memory otherSig = _sign(bobPk, other);
        vm.expectRevert(ValidationReceipts.BadAttestation.selector);
        receipts.validate(other, otherSig, none, good); // attestation can't be reused

        uint256 id = receipts.validate(a, sig, none, good);
        assertEq(receipts.receiptOf(id).proofRef, proofRef);
    }

    // ------------------------------------------------------------ merge gate
    function test_MergeGate() public {
        bytes32 c = keccak256("c1");
        _validate(bobPk, REPO_WEB, c, 1);
        assertTrue(receipts.canMerge(carol, REPO_WEB, c));
        assertFalse(receipts.canMerge(bob, REPO_WEB, c), "bob lacks MERGE_PROTECTED");
    }

    // ------------------------------------------------------------- forensics
    function test_OnlyForensicsCanAudit() public {
        uint256 id = _bobValidates();
        bytes32 role = receipts.FORENSICS_ROLE();
        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, carol, role));
        receipts.audit(id, false, EVIDENCE, false);
    }

    function test_ForensicsCannotAuditOwnReceipt() public {
        uint256 id = _bobValidates();
        vm.startPrank(admin);
        receipts.grantRole(receipts.FORENSICS_ROLE(), bob);
        vm.stopPrank();
        vm.prank(bob);
        vm.expectRevert(ValidationReceipts.OwnReceipt.selector);
        receipts.audit(id, false, EVIDENCE, false);
    }

    // ----------------------------------------------- audit regression tests
    /// M-01: a validator could take the forensics role on a second, unenrolled address
    function test_M01_UnenrolledForensicsCannotRule() public {
        uint256 id = _bobValidates();
        address sock = makeAddr("bob-sock-puppet");
        bytes32 role = receipts.FORENSICS_ROLE();
        vm.prank(admin);
        receipts.grantRole(role, sock);
        vm.prank(sock);
        vm.expectRevert(ValidationReceipts.NotEnrolled.selector);
        receipts.audit(id, true, EVIDENCE, false);
    }

    /// M-02: a validator holding the appeals role could overturn their own appeal
    function test_M02_ValidatorCannotResolveOwnAppeal() public {
        vm.startPrank(admin);
        receipts.setConfig(30 days, 3 days, address(0));
        receipts.grantRole(receipts.APPEALS_ROLE(), bob);
        vm.stopPrank();
        uint256 id = _bobValidates();
        _wrong(id, false);
        vm.prank(bob);
        receipts.appeal(id, "r");
        vm.prank(bob);
        vm.expectRevert(ValidationReceipts.OwnReceipt.selector);
        receipts.resolveAppeal(id, true);
        address sock = makeAddr("appeals-sock");
        bytes32 role = receipts.APPEALS_ROLE();
        vm.prank(admin);
        receipts.grantRole(role, sock);
        vm.prank(sock);
        vm.expectRevert(ValidationReceipts.NotEnrolled.selector);
        receipts.resolveAppeal(id, true);
    }

    /// M-03: fees are paid by the transaction sender, never pulled from a stored account
    function test_M03_FeePaidBySubmitterOfTx() public {
        MockUSD usd = new MockUSD();
        address platform = makeAddr("platform");
        uint8[] memory tiers = new uint8[](1);
        uint256[] memory amts = new uint256[](1);
        tiers[0] = 1;
        amts[0] = 0.5e18;
        vm.prank(admin);
        receipts.setFees(usd, platform, tiers, amts);

        ValidationReceipts.HumanApproval memory a = _approval(REPO_WEB, keccak256("fee"), 10, 1);
        bytes memory sig = _sign(bobPk, a);
        HumanProof memory none;
        vm.prank(relayer); // relayer has no tokens / allowance -> cannot validate for free
        vm.expectRevert();
        receipts.validate(a, sig, none, _noAtt());

        usd.mint(relayer, 1e18);
        vm.startPrank(relayer);
        usd.approve(address(receipts), 1e18);
        receipts.validate(a, sig, none, _noAtt());
        vm.stopPrank();
        assertEq(usd.balanceOf(platform), 0.5e18);
        assertEq(usd.balanceOf(relayer), 0.5e18);
    }

    function test_L_ZeroTreasuryRejected() public {
        MockUSD usd = new MockUSD();
        uint8[] memory tiers = new uint8[](0);
        uint256[] memory amts = new uint256[](0);
        vm.prank(admin);
        vm.expectRevert(ValidationReceipts.ZeroTreasury.selector);
        receipts.setFees(usd, address(0), tiers, amts);
    }

    function test_AuditRequiresEvidenceAndWindowAndRealReceipt() public {
        uint256 id = _bobValidates();
        vm.startPrank(forensics);
        vm.expectRevert(ValidationReceipts.EvidenceRequired.selector);
        receipts.audit(id, false, bytes32(0), false);
        vm.expectRevert(ValidationReceipts.BadStatus.selector);
        receipts.audit(999, false, EVIDENCE, false); // no such receipt
        vm.warp(vm.getBlockTimestamp() + 30 days + 1);
        vm.expectRevert(ValidationReceipts.LiabilityWindowClosed.selector);
        receipts.audit(id, false, EVIDENCE, false);
        vm.stopPrank();
        assertTrue(receipts.isSettledSuccess(id));
    }

    function test_AuditCorrectMintsNothing() public {
        uint256 id = _bobValidates();
        vm.prank(forensics);
        receipts.audit(id, true, EVIDENCE, false);
        assertEq(uint8(receipts.receiptOf(id).status), uint8(ValidationReceipts.Status.Cleared));
        assertEq(ledger.balanceOf(bob), 0);
    }

    function test_AuditWrongMintsPenaltyToValidator() public {
        uint256 id = _bobValidates();
        _wrong(id, false);
        assertEq(ledger.balanceOf(bob), 1, "minted without bob's consent");
        assertEq(ledger.penaltyOf(1).receiptId, id);
        assertEq(_score(bob), 100 * WAD);
        assertFalse(receipts.canMerge(carol, REPO_WEB, receipts.receiptOf(id).commitHash));
    }

    // ----------------------------------------------------------- due process
    function test_PenaltyWaitsForAppealWindowThenFinalizes() public {
        vm.prank(admin);
        receipts.setConfig(30 days, 3 days, address(0));
        uint256 id = _bobValidates();
        _wrong(id, false);
        assertEq(ledger.balanceOf(bob), 0, "nothing before due process ends");
        vm.expectRevert(ValidationReceipts.AppealWindowOpen.selector);
        receipts.finalize(id);
        vm.warp(vm.getBlockTimestamp() + 3 days + 1);
        vm.prank(bob);
        vm.expectRevert(ValidationReceipts.AppealWindowClosed.selector);
        receipts.appeal(id, "late");
        receipts.finalize(id); // anyone
        assertEq(ledger.balanceOf(bob), 1);
        vm.expectRevert(ValidationReceipts.BadStatus.selector);
        receipts.finalize(id);
    }

    function test_AppealOverturnedByDifferentReviewer() public {
        vm.startPrank(admin);
        receipts.setConfig(30 days, 3 days, address(0));
        receipts.grantRole(receipts.APPEALS_ROLE(), forensics); // judge also holds appeals role
        vm.stopPrank();
        uint256 id = _bobValidates();
        vm.prank(alice);
        receipts.flag(id, EVIDENCE);
        vm.prank(forensics);
        receipts.resolveFlag(id, true, false);
        vm.prank(bob);
        receipts.appeal(id, keccak256("defect was outside the diff I was shown"));
        vm.prank(forensics);
        vm.expectRevert(ValidationReceipts.SameReviewerAsJudge.selector);
        receipts.resolveAppeal(id, true);
        vm.prank(appeals);
        receipts.resolveAppeal(id, true);
        assertEq(uint8(receipts.receiptOf(id).status), uint8(ValidationReceipts.Status.Overturned));
        assertEq(ledger.balanceOf(bob), 0);
        (uint32 fs,) = perms.flagStrikes(_h(alice));
        assertEq(fs, 1, "overturned flag counts against the flagger");
    }

    function test_AppealConfirmedMintsPenalty() public {
        vm.prank(admin);
        receipts.setConfig(30 days, 3 days, address(0));
        uint256 id = _bobValidates();
        _wrong(id, true);
        vm.prank(bob);
        receipts.appeal(id, "r");
        vm.prank(appeals);
        receipts.resolveAppeal(id, false);
        assertEq(ledger.balanceOf(bob), 1);
        assertEq(_score(bob), 200 * WAD, "major = base x 2");
    }

    function test_OnlyTheValidatorCanAppeal() public {
        vm.prank(admin);
        receipts.setConfig(30 days, 3 days, address(0));
        uint256 id = _bobValidates();
        _wrong(id, false);
        vm.prank(alice);
        vm.expectRevert(ValidationReceipts.NotTheValidator.selector);
        receipts.appeal(id, "r");
        vm.prank(mal); // not enrolled at all
        vm.expectRevert(ValidationReceipts.NotTheValidator.selector);
        receipts.appeal(id, "r");
    }

    function test_BaselessFlagsSuspendFlagging() public {
        for (uint256 i; i < 2; ++i) {
            uint256 id = _bobValidates();
            vm.prank(alice);
            receipts.flag(id, EVIDENCE);
            vm.prank(forensics);
            receipts.resolveFlag(id, false, false);
        }
        assertFalse(perms.has(_h(alice), perms.FLAG(), 1));
    }

    function test_KeyRotationKeepsScore() public {
        _wrong(_bobValidates(), false);
        (address bobNew, uint256 bobNewPk) = makeAddrAndKey("bob-new-phone");
        HumanProof memory p = _proof(humans.rotateSignal(bobNew), 2);
        vm.prank(bobNew);
        humans.rotateKey(p);
        assertEq(ledger.scoreOf(humans.humanOf(bobNew)), 100 * WAD, "score follows the human");

        // the old key is dead; the new key validates and the next penalty lands on the new key
        ValidationReceipts.HumanApproval memory a = _approval(REPO_WEB, keccak256("after-rotation"), 10, 1);
        HumanProof memory none;
        bytes memory oldSig = _sign(bobPk, a);
        vm.expectRevert(ValidationReceipts.BadSignature.selector);
        receipts.validate(a, oldSig, none, _noAtt());
        uint256 id = receipts.validate(a, _sign(bobNewPk, a), none, _noAtt());
        _wrong(id, false);
        assertEq(ledger.balanceOf(bobNew), 1);
        assertEq(ledger.balanceOf(bob), 1, "history stays where it was minted");
    }
}
