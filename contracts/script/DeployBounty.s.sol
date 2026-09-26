// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {HumanRegistry} from "../src/HumanRegistry.sol";
import {RewardToken} from "../src/RewardToken.sol";
import {Bounty} from "../src/Bounty.sol";

/// @notice Deploys RewardToken + one Bounty next to an existing deployment (config/<chainId>.json).
///
/// Environment variables:
///   JUDGE              required  awards and slashes (the relayer in the demo)
///   BOUNTY_CODE_HASH   required  keccak256 of the challenge code
///   BOUNTY_CODE_URI    required  link to the challenge code
///   BOUNTY_OPENS_IN    optional  seconds from now until claims open (default 1)
///   BOUNTY_THRESHOLD   optional  tokens needed to qualify (default 5)
///   TOKEN_COOLDOWN     optional  seconds between two tokens of one human (default 30)
///   BOUNTY_FUND_WEI    optional  prize pool (default 0)
/// Output: config/<chainId>.bounty.json on --broadcast.
contract DeployBounty is Script {
    function run() external returns (RewardToken token, Bounty bounty) {
        string memory cfg = vm.readFile(string.concat(vm.projectRoot(), "/../config/", vm.toString(block.chainid), ".json"));
        HumanRegistry humans = HumanRegistry(vm.parseJsonAddress(cfg, ".contracts.HumanRegistry"));
        address judge = vm.envAddress("JUDGE");
        bytes32 codeHash = vm.envBytes32("BOUNTY_CODE_HASH");
        string memory codeURI = vm.envString("BOUNTY_CODE_URI");
        uint64 opensAt = uint64(block.timestamp + vm.envOr("BOUNTY_OPENS_IN", uint256(1)));
        uint32 threshold = uint32(vm.envOr("BOUNTY_THRESHOLD", uint256(5)));
        uint64 cooldown = uint64(vm.envOr("TOKEN_COOLDOWN", uint256(30)));
        uint256 fundWei = vm.envOr("BOUNTY_FUND_WEI", uint256(0));

        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();
        token = new RewardToken(deployer, cooldown);
        bounty = new Bounty(humans, token, deployer, codeHash, codeURI, opensAt, threshold);
        token.grantRole(token.MINTER_ROLE(), address(bounty));
        token.grantRole(token.JUDGE_ROLE(), judge);
        bounty.grantRole(bounty.JUDGE_ROLE(), judge);
        if (fundWei != 0) bounty.fund{value: fundWei}();
        vm.stopBroadcast();

        console.log("RewardToken", address(token));
        console.log("Bounty     ", address(bounty));
        if (vm.isContext(VmSafe.ForgeContext.ScriptBroadcast)) {
            string memory o = "bounty";
            vm.serializeUint(o, "chainId", block.chainid);
            vm.serializeUint(o, "blockNumber", block.number);
            vm.serializeAddress(o, "judge", judge);
            vm.serializeUint(o, "claimOpensAt", opensAt);
            vm.serializeUint(o, "cooldown", cooldown);
            vm.serializeUint(o, "threshold", threshold);
            vm.serializeBytes32(o, "codeHash", codeHash);
            vm.serializeString(o, "codeURI", codeURI);
            vm.serializeAddress(o, "RewardToken", address(token));
            string memory out = vm.serializeAddress(o, "Bounty", address(bounty));
            vm.writeJson(out, string.concat(vm.projectRoot(), "/../config/", vm.toString(block.chainid), ".bounty.json"));
        }
    }
}
