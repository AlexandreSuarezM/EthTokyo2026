// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Read-only view of penalty stages (consumed by PermissionRegistry).
interface IPenaltyStages {
    function stageOf(bytes32 human) external view returns (uint8);
}

/// @notice Minting surface used by ValidationReceipts.
interface IPenaltyMinter is IPenaltyStages {
    function penalize(bytes32 human, uint256 receiptId, bytes32 evidenceHash, bool major)
        external
        returns (uint256 tokenId);
}
