// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Proof-of-personhood proof as produced by the identity provider (World ID by default).
struct HumanProof {
    uint256 root;
    uint256 nullifier; // same value for the same human + app + action (World ID 3.x semantics)
    uint256[8] proof;
}

/// @notice Swappable personhood layer. World ID is the default implementation; a KYC or
///         corporate-identity provider can implement the same interface.
interface IHumanVerifier {
    /// @dev MUST revert if `p` is not a valid proof that a unique human committed to `signal`.
    function verify(bytes32 signal, HumanProof calldata p) external view;
}

/// @notice Optional readable mirror of permissions (e.g. ENS subnames). Never the source of truth.
interface IRoleMirror {
    function sync(address account, bytes32 perm, uint64 value, uint64 activeUntil) external;
}
