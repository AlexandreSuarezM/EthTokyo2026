// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice On-chain World ID router interface (World ID 3.x Semaphore-based verifier).
/// @dev verifyProof REVERTS when the proof is invalid. It does NOT track nullifier reuse:
///      the calling application is responsible for that.
interface IWorldID {
    function verifyProof(
        uint256 root,
        uint256 groupId,
        uint256 signalHash,
        uint256 nullifierHash,
        uint256 externalNullifierHash,
        uint256[8] calldata proof
    ) external view;
}
