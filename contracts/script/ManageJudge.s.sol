// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {RewardToken} from "../src/RewardToken.sol";
import {Bounty} from "../src/Bounty.sol";

/// @notice Adds or removes a judge: JUDGE_ROLE on the Bounty (award tokens) and on the RewardToken
///         (slash tokens). Addresses come from config/<chainId>.bounty.json. Run by the admin (deployer).
///
///   JUDGE_ADDRESS   required  the judge to add or remove
///   JUDGE_ACTION    optional  "grant" (default) or "revoke"
contract ManageJudge is Script {
    error UnknownAction(string action);

    function run() external {
        string memory cfg =
            vm.readFile(string.concat(vm.projectRoot(), "/../config/", vm.toString(block.chainid), ".bounty.json"));
        Bounty bounty = Bounty(vm.parseJsonAddress(cfg, ".Bounty"));
        RewardToken token = RewardToken(vm.parseJsonAddress(cfg, ".RewardToken"));
        address judge = vm.envAddress("JUDGE_ADDRESS");
        string memory action = vm.envOr("JUDGE_ACTION", string("grant"));
        bool grant = keccak256(bytes(action)) == keccak256("grant");
        if (!grant && keccak256(bytes(action)) != keccak256("revoke")) revert UnknownAction(action);

        bytes32 bountyRole = bounty.JUDGE_ROLE();
        bytes32 tokenRole = token.JUDGE_ROLE();
        vm.startBroadcast();
        if (grant) {
            bounty.grantRole(bountyRole, judge);
            token.grantRole(tokenRole, judge);
        } else {
            bounty.revokeRole(bountyRole, judge);
            token.revokeRole(tokenRole, judge);
        }
        vm.stopBroadcast();
        console.log(grant ? "judge granted" : "judge revoked", judge);
        console.log("  can award (Bounty):     ", bounty.hasRole(bountyRole, judge));
        console.log("  can slash (RewardToken):", token.hasRole(tokenRole, judge));
    }
}
