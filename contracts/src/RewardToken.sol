// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @title RewardToken
/// @notice Soulbound reward tokens for careful validators, shared by every Bounty.
///
///  SOULBOUND  Balances only: there is no transfer, approve or sell function at all. Keyed by humanId,
///             so tokens follow the person across key rotation.
///  SLOW       One shared cooldown per human across ALL bounties: a human can gain a token only if
///             `cooldown` seconds passed since their last one, whichever bounty paid it. Two bounties
///             can't be farmed in parallel.
///  MINT       Only bounty contracts (MINTER_ROLE).
///  SLASH      The judge (JUDGE_ROLE) or the owner sets a human's balance to 0, with a reason.
contract RewardToken is AccessControl {
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE"); // bounty contracts
    bytes32 public constant JUDGE_ROLE = keccak256("JUDGE_ROLE"); //   may slash

    uint64 public immutable cooldown;
    mapping(bytes32 human => uint32) public balanceOf;
    mapping(bytes32 human => uint64) public lastMintAt;

    event Minted(bytes32 indexed human, address indexed bounty, uint32 balance);
    event Slashed(bytes32 indexed human, address indexed by, uint32 lost, bytes32 reasonHash);

    error CooldownActive(uint64 nextAt);
    error ReasonRequired();
    error NoHuman();

    constructor(address admin, uint64 _cooldown) {
        cooldown = _cooldown;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    function mint(bytes32 human) external onlyRole(MINTER_ROLE) returns (uint32 balance) {
        if (human == bytes32(0)) revert NoHuman();
        uint64 last = lastMintAt[human];
        if (last != 0 && block.timestamp < last + cooldown) revert CooldownActive(last + cooldown);
        lastMintAt[human] = uint64(block.timestamp);
        balance = ++balanceOf[human];
        emit Minted(human, msg.sender, balance);
    }

    /// @notice All tokens lost (a wrong validation). By the judge or the owner.
    function slash(bytes32 human, bytes32 reasonHash) external {
        if (!hasRole(JUDGE_ROLE, msg.sender) && !hasRole(DEFAULT_ADMIN_ROLE, msg.sender)) {
            revert AccessControlUnauthorizedAccount(msg.sender, JUDGE_ROLE);
        }
        if (reasonHash == bytes32(0)) revert ReasonRequired();
        uint32 lost = balanceOf[human];
        balanceOf[human] = 0;
        emit Slashed(human, msg.sender, lost, reasonHash);
    }

    /// @notice Seconds until `human` can gain the next token (0 = now).
    function secondsUntilNext(bytes32 human) external view returns (uint256) {
        uint64 last = lastMintAt[human];
        if (last == 0 || block.timestamp >= last + cooldown) return 0;
        return last + cooldown - block.timestamp;
    }
}
