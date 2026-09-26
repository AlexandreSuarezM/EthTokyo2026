// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {HumanRegistry} from "./HumanRegistry.sol";
import {ValidationReceipts} from "./ValidationReceipts.sol";

/// @title ChallengeRewards
/// @notice The positive side of accountability: reward POINTS for correct validations, and a prize
///         pool shared by those who earned enough of them before a deadline.
///
///  POINTS      Soulbound: there is no transfer, approve or sell function at all. Keyed by humanId, so
///              they follow the person across key rotation.
///  EARN        The judge (JUDGE_ROLE) awards 1 point for a REAL receipt it ruled correct: once per
///              receipt, only to that receipt's validator, at most one point per `cooldown` (the
///              challenge difficulty, e.g. hours), so points are earned slowly.
///  SLASH       The judge (on a wrong validation) or the owner (DEFAULT_ADMIN_ROLE) can slash a human's
///              points to 0. The accountability (penalty) token lives in PenaltyLedger and is separate.
///  OPT IN      A human holding >= `threshold` points may opt in before the deadline. Opting in is
///              final: a later slash takes the points, never the prize share.
///  PRIZE       ETH funded by the owner. After the deadline every opted-in human claims an equal share.
///              If nobody opted in, the owner withdraws the pool. Payouts go to msg.sender, who must be
///              the human's current account (checks-effects-interactions, reentrancy-guarded).
contract ChallengeRewards is AccessControl, ReentrancyGuard {
    bytes32 public constant JUDGE_ROLE = keccak256("JUDGE_ROLE");

    HumanRegistry public immutable humans;
    ValidationReceipts public immutable receipts;
    uint64 public immutable deadline;
    uint64 public immutable cooldown; // seconds between two points of one human (difficulty)
    uint32 public immutable threshold; // points needed to opt in

    mapping(bytes32 human => uint32) public pointsOf;
    mapping(bytes32 human => uint64) public lastPointAt;
    mapping(uint256 receiptId => bool) public rewarded;
    mapping(bytes32 human => bool) public optedIn;
    mapping(bytes32 human => bool) public claimed;
    uint256 public optedInCount;
    uint256 public poolAtDeadline; // snapshot at the first claim: every share is computed from it

    event Funded(address indexed from, uint256 amount);
    event PointAwarded(bytes32 indexed human, uint256 indexed receiptId, uint32 points);
    event Slashed(bytes32 indexed human, address indexed by, uint32 lost, bytes32 reasonHash);
    event OptedIn(bytes32 indexed human, uint32 points);
    event Claimed(bytes32 indexed human, address indexed to, uint256 amount);
    event Withdrawn(address indexed to, uint256 amount);

    error BadConfig();
    error DeadlinePassed();
    error DeadlineNotReached();
    error AlreadyRewarded();
    error NotTheValidator();
    error NotStanding();
    error CooldownActive(uint64 nextAt);
    error NotEnrolled();
    error NotEnoughPoints();
    error AlreadyOptedIn();
    error NotOptedIn();
    error AlreadyClaimed();
    error SomeoneOptedIn();
    error ReasonRequired();
    error TransferFailed();

    constructor(
        HumanRegistry _humans,
        ValidationReceipts _receipts,
        address admin,
        uint64 _deadline,
        uint64 _cooldown,
        uint32 _threshold
    ) {
        if (_deadline <= block.timestamp || _threshold == 0) revert BadConfig();
        humans = _humans;
        receipts = _receipts;
        deadline = _deadline;
        cooldown = _cooldown;
        threshold = _threshold;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    // ================================================================ pool
    function fund() external payable onlyRole(DEFAULT_ADMIN_ROLE) {
        if (block.timestamp > deadline) revert DeadlinePassed();
        emit Funded(msg.sender, msg.value);
    }

    // ============================================================== points
    /// @notice 1 point for a real receipt the judge ruled correct, at most one per `cooldown`.
    function award(bytes32 human, uint256 receiptId) external onlyRole(JUDGE_ROLE) {
        if (block.timestamp > deadline) revert DeadlinePassed();
        if (rewarded[receiptId]) revert AlreadyRewarded();
        ValidationReceipts.Receipt memory rc = receipts.receiptOf(receiptId);
        if (rc.validatorHuman != human || human == bytes32(0)) revert NotTheValidator();
        // Valid (never ruled) or Cleared (ruled correct); anything else was not a correct validation
        if (rc.status != ValidationReceipts.Status.Valid && rc.status != ValidationReceipts.Status.Cleared) {
            revert NotStanding();
        }
        uint64 last = lastPointAt[human];
        if (last != 0 && block.timestamp < last + cooldown) revert CooldownActive(last + cooldown);

        rewarded[receiptId] = true;
        lastPointAt[human] = uint64(block.timestamp);
        uint32 p = ++pointsOf[human];
        emit PointAwarded(human, receiptId, p);
    }

    /// @notice All points lost. By the judge (after a wrong validation) or the owner. The prize share
    ///         of an opted-in human is not affected.
    function slash(bytes32 human, bytes32 reasonHash) external {
        if (!hasRole(JUDGE_ROLE, msg.sender) && !hasRole(DEFAULT_ADMIN_ROLE, msg.sender)) {
            revert AccessControlUnauthorizedAccount(msg.sender, JUDGE_ROLE);
        }
        if (reasonHash == bytes32(0)) revert ReasonRequired();
        uint32 lost = pointsOf[human];
        pointsOf[human] = 0;
        emit Slashed(human, msg.sender, lost, reasonHash);
    }

    /// @notice Seconds until `human` can earn the next point (0 = now).
    function secondsUntilNextPoint(bytes32 human) external view returns (uint256) {
        uint64 last = lastPointAt[human];
        if (last == 0 || block.timestamp >= last + cooldown) return 0;
        return last + cooldown - block.timestamp;
    }

    // =============================================================== prize
    function optIn() external {
        bytes32 human = humans.humanOf(msg.sender);
        if (human == bytes32(0)) revert NotEnrolled();
        if (block.timestamp > deadline) revert DeadlinePassed();
        if (optedIn[human]) revert AlreadyOptedIn();
        if (pointsOf[human] < threshold) revert NotEnoughPoints();
        optedIn[human] = true;
        ++optedInCount;
        emit OptedIn(human, pointsOf[human]);
    }

    /// @notice Equal share of the pool, after the deadline, once per opted-in human.
    function claim() external nonReentrant {
        if (block.timestamp <= deadline) revert DeadlineNotReached();
        bytes32 human = humans.humanOf(msg.sender);
        if (human == bytes32(0)) revert NotEnrolled();
        if (!optedIn[human]) revert NotOptedIn();
        if (claimed[human]) revert AlreadyClaimed();
        if (poolAtDeadline == 0) poolAtDeadline = address(this).balance;
        uint256 amount = poolAtDeadline / optedInCount;
        claimed[human] = true; // effects before the transfer
        emit Claimed(human, msg.sender, amount);
        (bool ok,) = msg.sender.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    /// @notice Nobody opted in by the deadline: the funds go back to the owner.
    function withdraw(address payable to) external onlyRole(DEFAULT_ADMIN_ROLE) nonReentrant {
        if (block.timestamp <= deadline) revert DeadlineNotReached();
        if (optedInCount != 0) revert SomeoneOptedIn();
        uint256 amount = address(this).balance;
        emit Withdrawn(to, amount);
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    function shareOf() external view returns (uint256) {
        if (optedInCount == 0) return 0;
        return (poolAtDeadline == 0 ? address(this).balance : poolAtDeadline) / optedInCount;
    }
}
