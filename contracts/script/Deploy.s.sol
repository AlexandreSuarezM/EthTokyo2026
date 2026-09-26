// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";

import {HumanRegistry} from "../src/HumanRegistry.sol";
import {PermissionRegistry} from "../src/PermissionRegistry.sol";
import {ValidationReceipts} from "../src/ValidationReceipts.sol";
import {PenaltyLedger} from "../src/PenaltyLedger.sol";
import {WorldIDVerifier} from "../src/WorldIDVerifier.sol";
import {IWorldID} from "../src/interfaces/IWorldID.sol";
import {IHumanVerifier} from "../src/interfaces/IHumanVerifier.sol";
import {IPenaltyStages, IPenaltyMinter} from "../src/interfaces/IPenalty.sol";
import {MockUSD} from "../src/mocks/Mocks.sol";

/// @notice Deploys and wires the HITL contracts in attester mode, then applies an environment preset.
///         Mirrors legacy/src/contracts.js (deployAll + applyEnvironment).
///
/// Environment variables (no addresses are hard-coded):
///   ATTESTER                  required  backend key that co-signs World ID 4.0 results
///   HITL_ENV                  optional  preset name in /environments (default: team-default)
///   ADMIN                     optional  final DEFAULT_ADMIN_ROLE holder (default: the broadcaster)
///   OPERATOR                  optional  orchestrator/relayer holding OPERATOR_ROLE (default: the broadcaster)
///                                       the preset's "receipts.oracle": "operator" also makes it the ORACLE
///   FEE_TREASURY              optional  fee recipient when the preset has fees (default: ADMIN)
///   DEPLOY_WORLD_ID_VERIFIER  optional  true = also deploy the World ID 3.x on-chain adapter (default: false)
///   WORLD_ID_ROUTER, WORLD_APP_ID, WORLD_ACTION   required only when DEPLOY_WORLD_ID_VERIFIER=true
///
/// Output: config/<chainId>.json on --broadcast, config/<chainId>.dry-run.json otherwise.
contract Deploy is Script {
    struct Deployment {
        WorldIDVerifier verifier; // 0 unless DEPLOY_WORLD_ID_VERIFIER=true
        HumanRegistry humans;
        PermissionRegistry perms;
        ValidationReceipts receipts;
        PenaltyLedger ledger;
        address feeToken; //         0 unless the preset has fees
    }

    /// Inputs. Zero/empty values fall back to the defaults documented above.
    struct Params {
        string envName;
        address attester;
        address admin;
        address operator;
        address feeTreasury;
        bool deployVerifier;
        address worldIdRouter;
        string worldAppId;
        string worldAction;
    }

    struct Accounts {
        address deployer;
        address admin;
        address operator;
        address attester;
        address feeTreasury;
        address oracle; //          0 unless the preset names one
    }

    error ZeroAttester();
    error BadAmount(string value);

    function run() external returns (Deployment memory) {
        Params memory p;
        p.envName = vm.envOr("HITL_ENV", string("team-default"));
        p.attester = vm.envAddress("ATTESTER");
        p.admin = vm.envOr("ADMIN", address(0));
        p.operator = vm.envOr("OPERATOR", address(0));
        p.feeTreasury = vm.envOr("FEE_TREASURY", address(0));
        p.deployVerifier = vm.envOr("DEPLOY_WORLD_ID_VERIFIER", false);
        if (p.deployVerifier) {
            p.worldIdRouter = vm.envAddress("WORLD_ID_ROUTER");
            p.worldAppId = vm.envString("WORLD_APP_ID");
            p.worldAction = vm.envString("WORLD_ACTION");
        }
        return deploy(p);
    }

    /// @dev Public so tests can pass parameters without touching process-wide env vars.
    function deploy(Params memory p) public returns (Deployment memory d) {
        if (p.attester == address(0)) revert ZeroAttester();
        string memory json = vm.readFile(string.concat(vm.projectRoot(), "/../environments/", p.envName, ".json"));

        vm.startBroadcast();
        Accounts memory a;
        (, a.deployer,) = vm.readCallers();
        a.attester = p.attester;
        a.admin = p.admin == address(0) ? a.deployer : p.admin;
        a.operator = p.operator == address(0) ? a.deployer : p.operator;
        a.feeTreasury = p.feeTreasury == address(0) ? a.admin : p.feeTreasury;

        d = _deploy(p, json, a.deployer);
        _wire(d, a.operator);
        _applyEnvironment(d, json, a);
        _handOverAdmin(d, a);
        vm.stopBroadcast();

        _log(d, a, p.envName);
        if (vm.isContext(VmSafe.ForgeContext.ScriptGroup)) _writeConfig(d, a, p.envName);
    }

    // ============================================================== deploy
    function _deploy(Params memory p, string memory json, address deployer) internal returns (Deployment memory d) {
        if (p.deployVerifier) d.verifier = new WorldIDVerifier(IWorldID(p.worldIdRouter), p.worldAppId, p.worldAction);
        // the deployer is the temporary admin so it can configure; see _handOverAdmin
        d.humans = new HumanRegistry(IHumanVerifier(address(d.verifier)), deployer);
        d.perms = new PermissionRegistry(d.humans, deployer);
        d.receipts = new ValidationReceipts(d.humans, d.perms, IHumanVerifier(address(d.verifier)), deployer);
        d.ledger = new PenaltyLedger(d.humans, deployer, _penaltyConfig(json));
    }

    /// Same roles as deployAll: receipts sanctions flaggers and mints penalties; the operator
    /// consumes AI quotas; both registries read the ledger.
    function _wire(Deployment memory d, address operator) internal {
        d.perms.grantRole(d.perms.SANCTIONER_ROLE(), address(d.receipts));
        d.perms.grantRole(d.perms.OPERATOR_ROLE(), operator);
        d.perms.setLedger(IPenaltyStages(address(d.ledger)));
        d.receipts.setLedger(IPenaltyMinter(address(d.ledger)));
        d.ledger.grantRole(d.ledger.MINTER_ROLE(), address(d.receipts));
    }

    // ========================================================= environment
    function _applyEnvironment(Deployment memory d, string memory json, Accounts memory a) internal {
        d.perms
            .setPolicy(
                PermissionRegistry.Policy({
                    liveProofTier: uint8(vm.parseJsonUint(json, ".policy.liveProofTier")),
                    allowSelfApproval: vm.parseJsonBool(json, ".policy.allowSelfApproval"),
                    flagCooldown: uint64(vm.parseJsonUint(json, ".policy.flagCooldownDays") * 1 days),
                    flagStrikeWindow: uint64(vm.parseJsonUint(json, ".policy.flagStrikeWindowDays") * 1 days),
                    baselessFlagLimit: uint8(vm.parseJsonUint(json, ".policy.baselessFlagLimit")),
                    maxTierForSelfie: uint8(vm.parseJsonUint(json, ".policy.maxTierForSelfie"))
                })
            );

        // attester mode on both contracts: the ATTESTER env var overrides the preset's value
        d.receipts
            .setConfig(
                uint64(vm.parseJsonUint(json, ".receipts.liabilityWindowDays") * 1 days),
                uint64(vm.parseJsonUint(json, ".receipts.appealWindowDays") * 1 days),
                a.attester
            );
        d.humans.setAttester(a.attester);
        a.oracle = _applyOracle(d, json, a.operator);

        if (vm.keyExistsJson(json, ".fees.token")) d.feeToken = _applyFees(d, json, a.feeTreasury);
        _applyRepos(d, json);
        _applyPresets(d, json);
    }

    /// "receipts.oracle": "operator" grants ORACLE_ROLE to the operator (relayer); any other value
    /// must be an address. Absent: no oracle (rulings only by enrolled humans).
    function _applyOracle(Deployment memory d, string memory json, address operator) internal returns (address oracle) {
        if (!vm.keyExistsJson(json, ".receipts.oracle")) return address(0);
        string memory o = vm.parseJsonString(json, ".receipts.oracle");
        oracle = keccak256(bytes(o)) == keccak256("operator") ? operator : vm.parseAddress(o);
        d.receipts.grantRole(d.receipts.ORACLE_ROLE(), oracle);
    }

    function _penaltyConfig(string memory json) internal pure returns (PenaltyLedger.Config memory) {
        return PenaltyLedger.Config({
            base: uint32(vm.parseJsonUint(json, ".penalties.base")),
            majorMultiplier: uint16(vm.parseJsonUint(json, ".penalties.majorMultiplier")),
            escalationBps: uint32(vm.parseJsonUint(json, ".penalties.escalationPct") * 100),
            maxScore: uint32(vm.parseJsonUint(json, ".penalties.maxScore")),
            stage2At: uint32(vm.parseJsonUint(json, ".penalties.stage2At")),
            stage3At: uint32(vm.parseJsonUint(json, ".penalties.stage3At")),
            fadePeriod: uint64(vm.parseJsonUint(json, ".penalties.fadeDays") * 1 days)
        });
    }

    /// "mock" deploys a MockUSD (testnets only); otherwise `token` is an ERC-20 address.
    /// Amounts are decimal strings in whole tokens (18 decimals), like the legacy parseUnits(v, 18).
    function _applyFees(Deployment memory d, string memory json, address treasury) internal returns (address token) {
        string memory t = vm.parseJsonString(json, ".fees.token");
        token = keccak256(bytes(t)) == keccak256("mock") ? address(new MockUSD()) : vm.parseAddress(t);
        string[] memory keys = vm.parseJsonKeys(json, ".fees.byTier");
        uint8[] memory tiers = new uint8[](keys.length);
        uint256[] memory amounts = new uint256[](keys.length);
        for (uint256 i; i < keys.length; ++i) {
            tiers[i] = uint8(vm.parseUint(keys[i]));
            amounts[i] = _units18(vm.parseJsonString(json, string.concat(".fees.byTier.", keys[i])));
        }
        d.receipts.setFees(IERC20(token), treasury, tiers, amounts);
    }

    function _applyRepos(Deployment memory d, string memory json) internal {
        uint256 n = _arrayLength(json, ".repos");
        for (uint256 i; i < n; ++i) {
            string memory r = string.concat(".repos[", vm.toString(i), "]");
            d.perms
                .setRepo(
                    keccak256(bytes(vm.parseJsonString(json, string.concat(r, ".id")))),
                    uint8(vm.parseJsonUint(json, string.concat(r, ".tier"))),
                    uint8(vm.parseJsonUint(json, string.concat(r, ".requiredApprovals")))
                );
        }
    }

    function _applyPresets(Deployment memory d, string memory json) internal {
        string[] memory names = vm.parseJsonKeys(json, ".presets");
        for (uint256 i; i < names.length; ++i) {
            string memory p = string.concat(".presets.", names[i]);
            string[] memory grants = vm.parseJsonKeys(json, string.concat(p, ".grants"));
            bytes32[] memory perms = new bytes32[](grants.length);
            uint64[] memory values = new uint64[](grants.length);
            for (uint256 j; j < grants.length; ++j) {
                perms[j] = keccak256(bytes(grants[j])); // permId: keccak256("REPO_TIER") etc.
                values[j] = uint64(vm.parseJsonUint(json, string.concat(p, ".grants.", grants[j])));
            }
            uint64 duration = uint64(vm.parseJsonUint(json, string.concat(p, ".durationDays")) * 1 days);
            d.perms.definePreset(keccak256(bytes(names[i])), perms, values, duration);
        }
    }

    // =============================================================== admin
    /// If ADMIN is not the broadcaster, give it every admin role and drop the deployer's.
    function _handOverAdmin(Deployment memory d, Accounts memory a) internal {
        if (a.admin == a.deployer) return;
        IAccessControl[4] memory cs = [
            IAccessControl(address(d.humans)),
            IAccessControl(address(d.perms)),
            IAccessControl(address(d.receipts)),
            IAccessControl(address(d.ledger))
        ];
        for (uint256 i; i < cs.length; ++i) {
            cs[i].grantRole(bytes32(0), a.admin); // DEFAULT_ADMIN_ROLE
            cs[i].renounceRole(bytes32(0), a.deployer);
        }
    }

    // ============================================================== output
    function _writeConfig(Deployment memory d, Accounts memory a, string memory envName) internal {
        string memory c = "contracts";
        vm.serializeAddress(c, "HumanRegistry", address(d.humans));
        vm.serializeAddress(c, "PermissionRegistry", address(d.perms));
        vm.serializeAddress(c, "ValidationReceipts", address(d.receipts));
        if (address(d.verifier) != address(0)) vm.serializeAddress(c, "WorldIDVerifier", address(d.verifier));
        if (d.feeToken != address(0)) vm.serializeAddress(c, "FeeToken", d.feeToken);
        string memory contracts = vm.serializeAddress(c, "PenaltyLedger", address(d.ledger));

        bool dryRun = !vm.isContext(VmSafe.ForgeContext.ScriptBroadcast);
        string memory o = "deployment";
        vm.serializeUint(o, "chainId", block.chainid);
        vm.serializeUint(o, "blockNumber", block.number);
        vm.serializeString(o, "environment", envName);
        vm.serializeBool(o, "dryRun", dryRun);
        vm.serializeAddress(o, "deployer", a.deployer);
        vm.serializeAddress(o, "admin", a.admin);
        vm.serializeAddress(o, "operator", a.operator);
        vm.serializeAddress(o, "attester", a.attester);
        vm.serializeAddress(o, "oracle", a.oracle);
        string memory out = vm.serializeString(o, "contracts", contracts);

        string memory path = string.concat(
            vm.projectRoot(), "/../config/", vm.toString(block.chainid), dryRun ? ".dry-run.json" : ".json"
        );
        vm.writeJson(out, path);
        console.log("Wrote", path);
    }

    function _log(Deployment memory d, Accounts memory a, string memory envName) internal pure {
        console.log("environment       ", envName);
        console.log("admin             ", a.admin);
        console.log("attester          ", a.attester);
        console.log("oracle            ", a.oracle);
        console.log("HumanRegistry     ", address(d.humans));
        console.log("PermissionRegistry", address(d.perms));
        console.log("ValidationReceipts", address(d.receipts));
        console.log("PenaltyLedger     ", address(d.ledger));
    }

    // ============================================================= helpers
    function _arrayLength(string memory json, string memory key) internal view returns (uint256 n) {
        while (vm.keyExistsJson(json, string.concat(key, "[", vm.toString(n), "]"))) ++n;
    }

    /// "0.5" -> 5e17, "2" -> 2e18. At most 18 decimals.
    function _units18(string memory s) internal pure returns (uint256 v) {
        bytes memory b = bytes(s);
        uint256 decimals;
        bool dot;
        for (uint256 i; i < b.length; ++i) {
            if (b[i] == ".") {
                if (dot) revert BadAmount(s);
                dot = true;
                continue;
            }
            if (b[i] < "0" || b[i] > "9") revert BadAmount(s);
            v = v * 10 + (uint8(b[i]) - 48);
            if (dot) ++decimals;
        }
        if (b.length == 0 || decimals > 18) revert BadAmount(s);
        v *= 10 ** (18 - decimals);
    }
}
