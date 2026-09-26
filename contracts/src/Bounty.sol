// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {HumanRegistry} from "./HumanRegistry.sol";
import {RewardToken} from "./RewardToken.sol";

/// @title Bounty
/// @notice One code challenge with an ETH prize. Reviewing its code samples earns RewardTokens.
///
///  CODE       `codeHash` + `codeURI` name the challenge code under review.
///  EARN       The judge awards 1 RewardToken per code sample the human reviewed (approved OR
///             reported): once per sample id, only to enrolled humans, subject to the token's shared
///             cooldown. A wrong approval is then slashed on the RewardToken by the judge.
///  QUALIFY    A human holding >= `threshold` tokens opts in. Final: a later slash keeps the seat.
///  PRIZE      From `claimOpensAt`, each qualified human claims an equal share of what is left:
///             balance / (qualified - claimed). With everyone qualified before claims open, that is
///             exactly pool / qualified. Paid to msg.sender (the human's current account).
///  REFUND     After `claimOpensAt`, if nobody qualified, the owner withdraws the pool.
contract Bounty is AccessControl, ReentrancyGuard {
    bytes32 public constant JUDGE_ROLE = keccak256("JUDGE_ROLE");

    HumanRegistry public immutable humans;
    RewardToken public immutable token;
    bytes32 public immutable codeHash;
    string public codeURI;
    uint64 public immutable claimOpensAt;
    uint32 public immutable threshold;

    mapping(bytes32 sampleId => bool) public awarded;
    mapping(bytes32 human => bool) public qualified;
    mapping(bytes32 human => bool) public claimed;
    uint256 public qualifiedCount;
    uint256 public claimedCount;

    event Funded(address indexed from, uint256 amount);
    event Awarded(bytes32 indexed human, bytes32 indexed sampleId, uint32 balance);
    event Qualified(bytes32 indexed human, uint32 tokens);
    event Claimed(bytes32 indexed human, address indexed to, uint256 amount);
    event Withdrawn(address indexed to, uint256 amount);

    error BadConfig();
    error AlreadyAwarded();
    error NotEnrolled();
    error NotEnoughTokens();
    error AlreadyQualified();
    error NotQualified();
    error AlreadyClaimed();
    error ClaimNotOpen();
    error SomeoneQualified();
    error TransferFailed();

    constructor(
        HumanRegistry _humans,
        RewardToken _token,
        address admin,
        bytes32 _codeHash,
        string memory _codeURI,
        uint64 _claimOpensAt,
        uint32 _threshold
    ) {
        if (_threshold == 0 || _codeHash == bytes32(0)) revert BadConfig();
        humans = _humans;
        token = _token;
        codeHash = _codeHash;
        codeURI = _codeURI;
        claimOpensAt = _claimOpensAt;
        threshold = _threshold;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    function fund() external payable {
        emit Funded(msg.sender, msg.value);
    }

    /// @notice +1 RewardToken for reviewing one code sample (approved or reported). Once per sample.
    function award(bytes32 human, bytes32 sampleId) external onlyRole(JUDGE_ROLE) returns (uint32 balance) {
        if (awarded[sampleId]) revert AlreadyAwarded();
        if (humans.accountOf(human) == address(0)) revert NotEnrolled();
        awarded[sampleId] = true;
        balance = token.mint(human); // reverts CooldownActive: too fast
        emit Awarded(human, sampleId, balance);
    }

    function optIn() external {
        bytes32 human = humans.humanOf(msg.sender);
        if (human == bytes32(0)) revert NotEnrolled();
        if (qualified[human]) revert AlreadyQualified();
        uint32 tokens = token.balanceOf(human);
        if (tokens < threshold) revert NotEnoughTokens();
        qualified[human] = true;
        ++qualifiedCount;
        emit Qualified(human, tokens);
    }

    function claim() external nonReentrant {
        if (block.timestamp < claimOpensAt) revert ClaimNotOpen();
        bytes32 human = humans.humanOf(msg.sender);
        if (human == bytes32(0)) revert NotEnrolled();
        if (!qualified[human]) revert NotQualified();
        if (claimed[human]) revert AlreadyClaimed();
        uint256 amount = address(this).balance / (qualifiedCount - claimedCount);
        claimed[human] = true; // effects before the transfer
        ++claimedCount;
        emit Claimed(human, msg.sender, amount);
        (bool ok,) = msg.sender.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    function withdraw(address payable to) external onlyRole(DEFAULT_ADMIN_ROLE) nonReentrant {
        if (block.timestamp < claimOpensAt) revert ClaimNotOpen();
        if (qualifiedCount != 0) revert SomeoneQualified();
        uint256 amount = address(this).balance;
        emit Withdrawn(to, amount);
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    function shareNow() external view returns (uint256) {
        uint256 left = qualifiedCount - claimedCount;
        return left == 0 ? 0 : address(this).balance / left;
    }
}
