// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {HumanRegistry} from "../src/HumanRegistry.sol";
import {ValidationReceipts} from "../src/ValidationReceipts.sol";
import {ChallengeRewards} from "../src/ChallengeRewards.sol";

/// @notice Deploys ChallengeRewards next to an existing deployment (config/<chainId>.json), grants
///         JUDGE_ROLE and funds the prize pool. No addresses are hard-coded.
///
/// Environment variables:
///   JUDGE              required  the judge (the relayer in the demo)
///   REWARDS_DEADLINE   required  unix time after which the pool is claimable
///   REWARDS_COOLDOWN   optional  seconds between two points of one human (default 3600)
///   REWARDS_THRESHOLD  optional  points needed to opt in (default 5)
///   REWARDS_FUND_WEI   optional  initial prize pool (default 0)
/// Output: config/<chainId>.rewards.json on --broadcast.
contract DeployRewards is Script {
    function run() external returns (ChallengeRewards rewards) {
        string memory cfg = vm.readFile(string.concat(vm.projectRoot(), "/../config/", vm.toString(block.chainid), ".json"));
        HumanRegistry humans = HumanRegistry(vm.parseJsonAddress(cfg, ".contracts.HumanRegistry"));
        ValidationReceipts receipts = ValidationReceipts(vm.parseJsonAddress(cfg, ".contracts.ValidationReceipts"));
        address judge = vm.envAddress("JUDGE");
        uint64 deadline = uint64(vm.envUint("REWARDS_DEADLINE"));
        uint64 cooldown = uint64(vm.envOr("REWARDS_COOLDOWN", uint256(3600)));
        uint32 threshold = uint32(vm.envOr("REWARDS_THRESHOLD", uint256(5)));
        uint256 fundWei = vm.envOr("REWARDS_FUND_WEI", uint256(0));

        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();
        rewards = new ChallengeRewards(humans, receipts, deployer, deadline, cooldown, threshold);
        rewards.grantRole(rewards.JUDGE_ROLE(), judge);
        if (fundWei != 0) rewards.fund{value: fundWei}();
        vm.stopBroadcast();

        console.log("ChallengeRewards", address(rewards));
        console.log("judge           ", judge);
        console.log("deadline        ", deadline);
        if (vm.isContext(VmSafe.ForgeContext.ScriptBroadcast)) {
            string memory o = "rewards";
            vm.serializeUint(o, "chainId", block.chainid);
            vm.serializeUint(o, "blockNumber", block.number);
            vm.serializeAddress(o, "judge", judge);
            vm.serializeUint(o, "deadline", deadline);
            vm.serializeUint(o, "cooldown", cooldown);
            vm.serializeUint(o, "threshold", threshold);
            string memory out = vm.serializeAddress(o, "ChallengeRewards", address(rewards));
            vm.writeJson(out, string.concat(vm.projectRoot(), "/../config/", vm.toString(block.chainid), ".rewards.json"));
        }
    }
}
