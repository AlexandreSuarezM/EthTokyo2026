// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Deploy} from "../script/Deploy.s.sol";
import {PermissionRegistry} from "../src/PermissionRegistry.sol";
import {PenaltyLedger} from "../src/PenaltyLedger.sol";

/// @notice The deploy script wires roles like legacy deployAll and applies presets like applyEnvironment.
contract DeployTest is Test {
    Deploy script;
    address attester = makeAddr("attester");
    address operator = makeAddr("operator");
    address safe = makeAddr("admin-safe");

    function setUp() public {
        script = new Deploy();
    }

    function _params(string memory envName) internal view returns (Deploy.Params memory p) {
        p.envName = envName;
        p.attester = attester;
        p.operator = operator;
    }

    function _json(string memory envName) internal view returns (string memory) {
        return vm.readFile(string.concat(vm.projectRoot(), "/../environments/", envName, ".json"));
    }

    function test_DeployWiresRolesLikeLegacy() public {
        Deploy.Deployment memory d = script.deploy(_params("team-default"));
        address deployer = DEFAULT_SENDER;

        assertEq(address(d.verifier), address(0), "verifier is optional");
        assertTrue(d.perms.hasRole(d.perms.SANCTIONER_ROLE(), address(d.receipts)));
        assertTrue(d.perms.hasRole(d.perms.OPERATOR_ROLE(), operator));
        assertTrue(d.ledger.hasRole(d.ledger.MINTER_ROLE(), address(d.receipts)));
        assertEq(address(d.perms.ledger()), address(d.ledger));
        assertEq(address(d.receipts.ledger()), address(d.ledger));
        assertEq(address(d.perms.humans()), address(d.humans));
        assertEq(address(d.receipts.humans()), address(d.humans));

        // attester mode on both contracts
        assertEq(d.humans.attester(), attester);
        assertEq(d.receipts.attester(), attester);

        // no ruling roles are handed out at deploy time (they must go to enrolled humans)
        assertFalse(d.receipts.hasRole(d.receipts.FORENSICS_ROLE(), deployer));
        assertFalse(d.ledger.hasRole(d.ledger.EVALUATOR_ROLE(), deployer));
        // no oracle unless the preset names one
        assertFalse(d.receipts.hasRole(d.receipts.ORACLE_ROLE(), operator));
        assertFalse(d.receipts.hasRole(d.receipts.ORACLE_ROLE(), deployer));

        // the broadcaster stays admin when ADMIN is not set
        assertTrue(d.humans.hasRole(bytes32(0), deployer));
        assertTrue(d.receipts.hasRole(bytes32(0), deployer));
    }

    function test_DeployAppliesEnvironment() public {
        string[4] memory envs = ["team-default", "regulated-fintech", "solo-startup", "demo"];
        for (uint256 e; e < envs.length; ++e) {
            string memory json = _json(envs[e]);
            Deploy.Deployment memory d = script.deploy(_params(envs[e]));

            (uint8 liveTier, bool selfOk, uint64 cooldown, uint64 window, uint8 limit, uint8 selfieCap) =
                d.perms.policy();
            assertEq(liveTier, vm.parseJsonUint(json, ".policy.liveProofTier"));
            assertEq(selfOk, vm.parseJsonBool(json, ".policy.allowSelfApproval"));
            assertEq(cooldown, vm.parseJsonUint(json, ".policy.flagCooldownDays") * 1 days);
            assertEq(window, vm.parseJsonUint(json, ".policy.flagStrikeWindowDays") * 1 days);
            assertEq(limit, vm.parseJsonUint(json, ".policy.baselessFlagLimit"));
            assertEq(selfieCap, vm.parseJsonUint(json, ".policy.maxTierForSelfie"));

            assertEq(d.receipts.liabilityWindow(), vm.parseJsonUint(json, ".receipts.liabilityWindowDays") * 1 days);
            assertEq(d.receipts.appealWindow(), vm.parseJsonUint(json, ".receipts.appealWindowDays") * 1 days);

            (uint32 base, uint16 major, uint32 escBps, uint32 cap, uint32 s2, uint32 s3, uint64 fade) =
                d.ledger.config();
            assertEq(base, vm.parseJsonUint(json, ".penalties.base"));
            assertEq(major, vm.parseJsonUint(json, ".penalties.majorMultiplier"));
            assertEq(escBps, vm.parseJsonUint(json, ".penalties.escalationPct") * 100);
            assertEq(cap, vm.parseJsonUint(json, ".penalties.maxScore"));
            assertEq(s2, vm.parseJsonUint(json, ".penalties.stage2At"));
            assertEq(s3, vm.parseJsonUint(json, ".penalties.stage3At"));
            assertEq(fade, vm.parseJsonUint(json, ".penalties.fadeDays") * 1 days);

            for (uint256 i; vm.keyExistsJson(json, string.concat(".repos[", vm.toString(i), "]")); ++i) {
                string memory r = string.concat(".repos[", vm.toString(i), "]");
                PermissionRegistry.Repo memory repo =
                    d.perms.repo(keccak256(bytes(vm.parseJsonString(json, string.concat(r, ".id")))));
                assertEq(repo.tier, vm.parseJsonUint(json, string.concat(r, ".tier")));
                assertEq(repo.requiredApprovals, vm.parseJsonUint(json, string.concat(r, ".requiredApprovals")));
            }

            string[] memory names = vm.parseJsonKeys(json, ".presets");
            assertGt(names.length, 0);
            for (uint256 i; i < names.length; ++i) {
                string memory p = string.concat(".presets.", names[i]);
                PermissionRegistry.Preset memory preset = d.perms.presetOf(keccak256(bytes(names[i])));
                string[] memory grants = vm.parseJsonKeys(json, string.concat(p, ".grants"));
                assertEq(preset.perms.length, grants.length);
                assertEq(preset.duration, vm.parseJsonUint(json, string.concat(p, ".durationDays")) * 1 days);
                for (uint256 j; j < grants.length; ++j) {
                    assertEq(preset.perms[j], keccak256(bytes(grants[j])));
                    assertEq(preset.values[j], vm.parseJsonUint(json, string.concat(p, ".grants.", grants[j])));
                }
            }
        }
    }

    function test_DemoPresetMakesTheOperatorTheOracle() public {
        Deploy.Deployment memory d = script.deploy(_params("demo"));
        assertTrue(d.receipts.hasRole(d.receipts.ORACLE_ROLE(), operator)); // "oracle": "operator" = the relayer
        assertFalse(d.receipts.hasRole(d.receipts.ORACLE_ROLE(), DEFAULT_SENDER));
        assertEq(d.receipts.appealWindow(), 0);
        assertEq(d.receipts.liabilityWindow(), 365 days);

        // two mistakes reach stage 2: base 100, then 100 + 100% of 100
        (uint32 base,, uint32 escBps,, uint32 s2,, uint64 fade) = d.ledger.config();
        assertLt(base, s2);
        assertGe(base + base + (uint256(base) * escBps) / 10_000, s2);
        assertEq(fade, 1 days);
    }

    function test_DeployFeesFromDecimalStrings() public {
        Deploy.Deployment memory d = script.deploy(_params("regulated-fintech")); // byTier {"1":"0.5","3":"2"}
        assertTrue(d.feeToken != address(0));
        assertEq(address(d.receipts.feeToken()), d.feeToken);
        assertEq(d.receipts.treasury(), DEFAULT_SENDER); // defaults to the admin
        assertEq(d.receipts.feeByTier(1), 0.5 ether);
        assertEq(d.receipts.feeByTier(3), 2 ether);
        assertEq(d.receipts.feeByTier(2), 0);

        Deploy.Deployment memory none = script.deploy(_params("team-default")); // "fees": null
        assertEq(none.feeToken, address(0));
        assertEq(address(none.receipts.feeToken()), address(0));
    }

    function test_DeployHandsAdminToSafe() public {
        Deploy.Params memory p = _params("team-default");
        p.admin = safe;
        Deploy.Deployment memory d = script.deploy(p);
        address[4] memory cs = [address(d.humans), address(d.perms), address(d.receipts), address(d.ledger)];
        for (uint256 i; i < cs.length; ++i) {
            assertTrue(PermissionRegistry(cs[i]).hasRole(bytes32(0), safe));
            assertFalse(PermissionRegistry(cs[i]).hasRole(bytes32(0), DEFAULT_SENDER));
        }
    }

    function test_DeployRequiresAttester() public {
        Deploy.Params memory p = _params("team-default");
        p.attester = address(0);
        vm.expectRevert(Deploy.ZeroAttester.selector);
        script.deploy(p);
    }

    function test_DeployOptionalWorldIdVerifier() public {
        Deploy.Params memory p = _params("team-default");
        p.deployVerifier = true;
        p.worldIdRouter = makeAddr("world-id-router");
        p.worldAppId = "app_test";
        p.worldAction = "hitl-approve";
        Deploy.Deployment memory d = script.deploy(p);
        assertEq(address(d.verifier.worldId()), p.worldIdRouter);
        assertEq(address(d.humans.verifier()), address(d.verifier));
        assertEq(address(d.receipts.verifier()), address(d.verifier));
    }

    function test_DeployedStackEnrollsInAttesterMode() public {
        (address signer, uint256 pk) = makeAddrAndKey("attester-key");
        Deploy.Params memory p = _params("team-default");
        p.attester = signer;
        Deploy.Deployment memory d = script.deploy(p);

        address user = makeAddr("user");
        bytes32 human = keccak256("world-id-4:user");
        bytes32 ref = keccak256("verify-result");
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(pk, d.humans.enrollDigest(user, human, ref, d.humans.LEVEL_ORB(), deadline));
        vm.prank(user);
        d.humans.enrollAttested(human, ref, 1, deadline, abi.encodePacked(r, s, v));
        assertEq(d.humans.humanOf(user), human);
        assertEq(d.perms.stageOf(human), 0);
    }
}
