// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

import {IHumanVerifier, HumanProof} from "./interfaces/IHumanVerifier.sol";

uint8 constant CREDENTIAL_ORB = 1; //    Proof of Human (Orb)
uint8 constant CREDENTIAL_SELFIE = 2; // Selfie check

/// @title HumanRegistry
/// @notice ZONE 1 / "Set user auth". Binds exactly one unique human to one active account key.
/// @dev Everything downstream (permissions, strikes, marks) is keyed by `humanId`, not by address,
///      so a sanction follows the PERSON across key rotations. That is the reason to use
///      proof of personhood at all: a new key does not reset accountability.
///
///      Two modes, exactly one active at a time (same switch as ValidationReceipts):
///        attester == 0  ON-CHAIN   `enroll` / `rotateKey` verify a World ID 3.x proof; humanId = nullifier.
///        attester != 0  ATTESTED   `enrollAttested` / `rotateKeyAttested` accept an EIP-712 signature
///                                  from the backend that verified a World ID 4.0 proof off-chain.
///      The modes are exclusive because they derive humanId differently: if both were open, one
///      person could hold one account per mode (audit L-05).
contract HumanRegistry is AccessControl, EIP712 {
    uint8 public constant LEVEL_ORB = CREDENTIAL_ORB;
    uint8 public constant LEVEL_SELFIE = CREDENTIAL_SELFIE;

    bytes32 public constant ENROLL_TYPEHASH = keccak256(
        "AttestedEnroll(address account,bytes32 humanId,bytes32 sessionRef,uint8 credentialLevel,uint256 deadline)"
    );
    bytes32 public constant ROTATE_TYPEHASH =
        keccak256("AttestedRotate(address newAccount,bytes32 humanId,bytes32 sessionRef,uint256 deadline)");

    IHumanVerifier public immutable verifier;
    address public attester; // 0 = on-chain verifier mode

    mapping(address account => bytes32 humanId) public humanOf;
    mapping(bytes32 humanId => address account) public accountOf;
    mapping(bytes32 humanId => uint8 level) public levelOf;
    mapping(bytes32 humanId => bytes32 sessionRef) public sessionRefOf; // hash of the verified World ID result
    mapping(bytes32 digest => bool) public digestUsed;

    event Enrolled(bytes32 indexed humanId, address indexed account);
    event EnrolledAttested(bytes32 indexed humanId, address indexed account, uint8 level, bytes32 sessionRef);
    event KeyRotated(bytes32 indexed humanId, address indexed oldAccount, address indexed newAccount);
    event KeyRotatedAttested(bytes32 indexed humanId, bytes32 sessionRef);
    event AttesterSet(address indexed attester);

    error AlreadyEnrolled();
    error HumanAlreadyHasAccount();
    error UnknownHuman();
    error Expired();
    error BadAttestation();
    error DigestUsed();
    error BadLevel();
    error AttesterMode();
    error OnChainMode();

    constructor(IHumanVerifier _verifier, address admin) EIP712("HITLHumanRegistry", "1") {
        verifier = _verifier;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    // ============================================================ on-chain mode
    /// @notice Enroll msg.sender. The proof's signal commits to msg.sender, so a proof generated
    ///         for one account cannot be replayed to enroll another.
    function enroll(HumanProof calldata p) external returns (bytes32 humanId) {
        if (attester != address(0)) revert AttesterMode();
        if (humanOf[msg.sender] != bytes32(0)) revert AlreadyEnrolled();
        humanId = bytes32(p.nullifier);
        if (accountOf[humanId] != address(0)) revert HumanAlreadyHasAccount(); // one human, one account
        verifier.verify(enrollSignal(msg.sender), p);
        humanOf[msg.sender] = humanId;
        accountOf[humanId] = msg.sender;
        levelOf[humanId] = LEVEL_ORB; // World ID 3.x on-chain proofs are Orb credentials (groupId 1)
        emit Enrolled(humanId, msg.sender);
    }

    /// @notice Move a human to a new key (lost or compromised device). Requires a fresh proof by
    ///         the same human committing to the new key. Strikes and permissions are untouched.
    function rotateKey(HumanProof calldata p) external {
        if (attester != address(0)) revert AttesterMode();
        bytes32 humanId = bytes32(p.nullifier);
        address old = accountOf[humanId];
        if (old == address(0)) revert UnknownHuman();
        if (humanOf[msg.sender] != bytes32(0)) revert AlreadyEnrolled();
        verifier.verify(rotateSignal(msg.sender), p);
        delete humanOf[old];
        humanOf[msg.sender] = humanId;
        accountOf[humanId] = msg.sender;
        emit KeyRotated(humanId, old, msg.sender);
    }

    function enrollSignal(address account) public pure returns (bytes32) {
        return keccak256(abi.encode("hitl.enroll", account));
    }

    function rotateSignal(address account) public pure returns (bytes32) {
        return keccak256(abi.encode("hitl.rotate", account));
    }

    // ============================================================ attested mode
    /// @notice Enroll msg.sender with a backend attestation of a World ID 4.0 proof. The signed
    ///         message names the account, so an attestation cannot be used by anyone else.
    function enrollAttested(
        bytes32 humanId,
        bytes32 sessionRef,
        uint8 credentialLevel,
        uint256 deadline,
        bytes calldata attesterSig
    ) external {
        if (credentialLevel != LEVEL_ORB && credentialLevel != LEVEL_SELFIE) revert BadLevel();
        if (humanId == bytes32(0)) revert UnknownHuman();
        if (humanOf[msg.sender] != bytes32(0)) revert AlreadyEnrolled();
        if (accountOf[humanId] != address(0)) revert HumanAlreadyHasAccount(); // one human, one account
        _consumeAttestation(
            keccak256(abi.encode(ENROLL_TYPEHASH, msg.sender, humanId, sessionRef, credentialLevel, deadline)),
            sessionRef,
            deadline,
            attesterSig
        );
        humanOf[msg.sender] = humanId;
        accountOf[humanId] = msg.sender;
        levelOf[humanId] = credentialLevel;
        sessionRefOf[humanId] = sessionRef;
        emit Enrolled(humanId, msg.sender);
        emit EnrolledAttested(humanId, msg.sender, credentialLevel, sessionRef);
    }

    /// @notice Move an attested human to msg.sender. The credential level and everything keyed by
    ///         humanId (permissions, score) stay; only the session reference is refreshed.
    function rotateKeyAttested(bytes32 humanId, bytes32 sessionRef, uint256 deadline, bytes calldata attesterSig)
        external
    {
        address old = accountOf[humanId];
        if (old == address(0)) revert UnknownHuman();
        if (humanOf[msg.sender] != bytes32(0)) revert AlreadyEnrolled();
        _consumeAttestation(
            keccak256(abi.encode(ROTATE_TYPEHASH, msg.sender, humanId, sessionRef, deadline)),
            sessionRef,
            deadline,
            attesterSig
        );
        delete humanOf[old];
        humanOf[msg.sender] = humanId;
        accountOf[humanId] = msg.sender;
        sessionRefOf[humanId] = sessionRef;
        emit KeyRotated(humanId, old, msg.sender);
        emit KeyRotatedAttested(humanId, sessionRef);
    }

    /// @dev Checks → effects: the digest is marked used before any state that depends on it.
    function _consumeAttestation(bytes32 structHash, bytes32 sessionRef, uint256 deadline, bytes calldata sig)
        internal
    {
        address a = attester;
        if (a == address(0)) revert OnChainMode();
        if (block.timestamp > deadline) revert Expired();
        bytes32 digest = _hashTypedDataV4(structHash);
        if (digestUsed[digest]) revert DigestUsed();
        if (sessionRef == bytes32(0) || ECDSA.recover(digest, sig) != a) revert BadAttestation();
        digestUsed[digest] = true;
    }

    function enrollDigest(address account, bytes32 humanId, bytes32 sessionRef, uint8 credentialLevel, uint256 deadline)
        external
        view
        returns (bytes32)
    {
        return _hashTypedDataV4(
            keccak256(abi.encode(ENROLL_TYPEHASH, account, humanId, sessionRef, credentialLevel, deadline))
        );
    }

    function rotateDigest(address newAccount, bytes32 humanId, bytes32 sessionRef, uint256 deadline)
        external
        view
        returns (bytes32)
    {
        return _hashTypedDataV4(keccak256(abi.encode(ROTATE_TYPEHASH, newAccount, humanId, sessionRef, deadline)));
    }

    // ================================================================= admin
    /// @notice Switch modes: a nonzero attester turns on the attested paths and turns off the
    ///         on-chain ones; zero does the reverse. Existing enrollments are unaffected.
    function setAttester(address _attester) external onlyRole(DEFAULT_ADMIN_ROLE) {
        attester = _attester;
        emit AttesterSet(_attester);
    }

    // ================================================================= reads
    function requireHuman(address account) external view returns (bytes32 humanId) {
        humanId = humanOf[account];
        if (humanId == bytes32(0)) revert UnknownHuman();
    }
}
