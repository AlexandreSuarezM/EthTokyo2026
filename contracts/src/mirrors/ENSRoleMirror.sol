// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {IRoleMirror} from "../interfaces/IHumanVerifier.sol";

interface INameWrapper {
    function setSubnodeRecord(
        bytes32 parentNode,
        string calldata label,
        address owner,
        address resolver,
        uint64 ttl,
        uint32 fuses,
        uint64 expiry
    ) external returns (bytes32 node);
}

interface ITextAddrResolver {
    function setText(bytes32 node, string calldata key, string calldata value) external;
    function setAddr(bytes32 node, address a) external;
}

/// @title ENSRoleMirror
/// @notice Publishes each human's permissions as ENS text records on `<user>.<org>.eth`,
///         e.g. key "hitl.REPO_TIER" -> "2;until=1767225600".
/// @dev READ-ONLY MIRROR. Enforcement happens in PermissionRegistry / ValidationMark.
///      ENS cannot prove anything about a person; it only names roles readably across orgs.
///      This contract must own the wrapped parent name, and the parent must NOT burn
///      PARENT_CANNOT_CONTROL on user subnames, so the org can revoke.
///      NOT tested against live ENS in this scaffold; only the interface shape is used.
contract ENSRoleMirror is IRoleMirror, Ownable {
    using Strings for uint256;

    INameWrapper public immutable nameWrapper;
    ITextAddrResolver public immutable resolver;
    bytes32 public immutable parentNode; // namehash("<org>.eth")
    address public registry; //            PermissionRegistry allowed to call sync

    mapping(address account => bytes32 node) public nodeOf;
    mapping(bytes32 perm => string name) public permName;

    error OnlyRegistry();
    error NoName();

    constructor(INameWrapper _nw, ITextAddrResolver _resolver, bytes32 _parentNode, address owner_)
        Ownable(owner_)
    {
        nameWrapper = _nw;
        resolver = _resolver;
        parentNode = _parentNode;
    }

    function setRegistry(address r) external onlyOwner {
        registry = r;
    }

    function setPermName(bytes32 perm, string calldata name) external onlyOwner {
        permName[perm] = name;
    }

    /// @notice Give an enrolled account a readable name. The mirror keeps ownership so the user
    ///         cannot edit their own role records.
    function assignName(address account, string calldata label, uint64 expiry) external onlyOwner {
        bytes32 node = nameWrapper.setSubnodeRecord(parentNode, label, address(this), address(resolver), 0, 0, expiry);
        resolver.setAddr(node, account);
        nodeOf[account] = node;
    }

    function sync(address account, bytes32 perm, uint64 value, uint64 activeUntil) external override {
        if (msg.sender != registry) revert OnlyRegistry();
        bytes32 node = nodeOf[account];
        if (node == bytes32(0)) revert NoName(); // registry swallows this via try/catch
        string memory v = string.concat(uint256(value).toString(), ";until=", uint256(activeUntil).toString());
        resolver.setText(node, string.concat("hitl.", permName[perm]), v);
    }
}
