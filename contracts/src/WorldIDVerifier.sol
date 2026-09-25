// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IWorldID} from "./interfaces/IWorldID.sol";
import {IHumanVerifier, HumanProof} from "./interfaces/IHumanVerifier.sol";

/// @title WorldIDVerifier
/// @notice Adapter from IHumanVerifier to the World ID on-chain router.
/// @dev ONE action is used for both enrollment and approvals ("hitl-approve"). Under World ID 3.x
///      the nullifier is deterministic per (human, app, action), so every approval proof from the
///      same human yields the SAME nullifier that was stored at enrollment. That is what links
///      "the human who enrolled" to "the human approving now" cryptographically.
///      World ID 4.0 enforces one-time nullifiers for some action types; if the target deployment
///      uses 4.0 semantics, this linkage must be re-done (e.g. with session identifiers).
contract WorldIDVerifier is IHumanVerifier {
    IWorldID public immutable worldId;
    uint256 public immutable groupId; // 1 = Orb-verified credential
    uint256 public immutable externalNullifierHash;

    constructor(IWorldID _worldId, string memory appId, string memory action) {
        worldId = _worldId;
        groupId = 1;
        externalNullifierHash =
            _hashToField(abi.encodePacked(_hashToField(abi.encodePacked(appId)), action));
    }

    function verify(bytes32 signal, HumanProof calldata p) external view override {
        worldId.verifyProof(
            p.root, groupId, _hashToField(abi.encodePacked(signal)), p.nullifier, externalNullifierHash, p.proof
        );
    }

    /// @dev Same reduction World ID uses: keccak256 shifted into the SNARK scalar field.
    function _hashToField(bytes memory value) internal pure returns (uint256) {
        return uint256(keccak256(value)) >> 8;
    }
}
