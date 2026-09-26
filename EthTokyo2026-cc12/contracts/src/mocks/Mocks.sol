// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IWorldID} from "../interfaces/IWorldID.sol";

/// @notice LOCAL TESTING ONLY. Stands in for the World ID router. A "proof" is valid iff
///         proof[0] == keccak(root, signalHash, nullifier, externalNullifier), which reproduces
///         the property that matters here: a proof is bound to one signal and one human.
contract MockWorldID is IWorldID {
    error InvalidProof();

    function verifyProof(
        uint256 root,
        uint256, /* groupId */
        uint256 signalHash,
        uint256 nullifierHash,
        uint256 externalNullifierHash,
        uint256[8] calldata proof
    ) external pure override {
        if (proof[0] != uint256(keccak256(abi.encode(root, signalHash, nullifierHash, externalNullifierHash)))) {
            revert InvalidProof();
        }
    }
}

/// @notice LOCAL TESTING ONLY. Fee token for the monetization path.
contract MockUSD is ERC20 {
    constructor() ERC20("Mock USD", "mUSD") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
