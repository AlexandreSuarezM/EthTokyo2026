// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IHumanVerifier, HumanProof} from "./interfaces/IHumanVerifier.sol";

/// @title HumanRegistry
/// @notice ZONE 1 / "Set user auth". Binds exactly one unique human to one active account key.
/// @dev Everything downstream (permissions, strikes, marks) is keyed by `humanId`, not by address,
///      so a sanction follows the PERSON across key rotations. That is the reason to use
///      proof of personhood at all: a new key does not reset accountability.
contract HumanRegistry {
    IHumanVerifier public immutable verifier;

    mapping(address account => bytes32 humanId) public humanOf;
    mapping(bytes32 humanId => address account) public accountOf;

    event Enrolled(bytes32 indexed humanId, address indexed account);
    event KeyRotated(bytes32 indexed humanId, address indexed oldAccount, address indexed newAccount);

    error AlreadyEnrolled();
    error HumanAlreadyHasAccount();
    error UnknownHuman();

    constructor(IHumanVerifier _verifier) {
        verifier = _verifier;
    }

    /// @notice Enroll msg.sender. The proof's signal commits to msg.sender, so a proof generated
    ///         for one account cannot be replayed to enroll another.
    function enroll(HumanProof calldata p) external returns (bytes32 humanId) {
        if (humanOf[msg.sender] != bytes32(0)) revert AlreadyEnrolled();
        humanId = bytes32(p.nullifier);
        if (accountOf[humanId] != address(0)) revert HumanAlreadyHasAccount(); // one human, one account
        verifier.verify(enrollSignal(msg.sender), p);
        humanOf[msg.sender] = humanId;
        accountOf[humanId] = msg.sender;
        emit Enrolled(humanId, msg.sender);
    }

    /// @notice Move a human to a new key (lost or compromised device). Requires a fresh proof by
    ///         the same human committing to the new key. Strikes and permissions are untouched.
    function rotateKey(HumanProof calldata p) external {
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

    function requireHuman(address account) external view returns (bytes32 humanId) {
        humanId = humanOf[account];
        if (humanId == bytes32(0)) revert UnknownHuman();
    }
}
