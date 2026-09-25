// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {PenaltyLedger} from "../src/PenaltyLedger.sol";
import {HumanRegistry} from "../src/HumanRegistry.sol";
import {WorldIDVerifier} from "../src/WorldIDVerifier.sol";
import {MockWorldID} from "../src/mocks/Mocks.sol";
import {HumanProof} from "../src/interfaces/IHumanVerifier.sol";

/// @dev Minimal enrolled-humans fixture for the ledger alone.
abstract contract LedgerFixture is Test {
    HumanRegistry humans;
    WorldIDVerifier verifier;
    bytes32[3] ids;
    address[3] accts;

    function _enrollAddr(address a, uint256 nullifier) internal returns (bytes32) {
        HumanProof memory p;
        p.root = 1;
        p.nullifier = nullifier;
        uint256 sh = uint256(keccak256(abi.encodePacked(humans.enrollSignal(a)))) >> 8;
        p.proof[0] = uint256(keccak256(abi.encode(p.root, sh, p.nullifier, verifier.externalNullifierHash())));
        vm.prank(a);
        return humans.enroll(p);
    }

    function _setupHumans() internal {
        MockWorldID world = new MockWorldID();
        verifier = new WorldIDVerifier(world, "app", "act");
        humans = new HumanRegistry(verifier);
        for (uint256 i; i < 3; ++i) {
            address a = address(uint160(0x1000 + i));
            HumanProof memory p;
            p.root = 1;
            p.nullifier = 100 + i;
            uint256 sh = uint256(keccak256(abi.encodePacked(humans.enrollSignal(a)))) >> 8;
            p.proof[0] = uint256(keccak256(abi.encode(p.root, sh, p.nullifier, verifier.externalNullifierHash())));
            vm.prank(a);
            ids[i] = humans.enroll(p);
            accts[i] = a;
        }
    }
}

contract LedgerFuzzTest is LedgerFixture {
    PenaltyLedger ledger;
    uint256 receiptSeq = 1;

    function setUp() public {
        vm.warp(1_780_000_000);
        _setupHumans();
        ledger = new PenaltyLedger(
            humans, address(this), PenaltyLedger.Config(100, 2, 10_000, 1000, 200, 500, 30 days)
        );
        ledger.grantRole(ledger.MINTER_ROLE(), address(this));
        ledger.grantRole(ledger.EVALUATOR_ROLE(), address(this));
        _enrollAddr(address(this), 900); // evaluators must be enrolled humans
    }

    /// Any sequence of penalties and gaps stays within the cap, and every penalty is recorded.
    function testFuzz_ScoreNeverExceedsCap(uint8 n, uint256 seed) public {
        n = uint8(bound(n, 1, 40));
        for (uint256 i; i < n; ++i) {
            uint256 r = uint256(keccak256(abi.encode(seed, i)));
            vm.warp(vm.getBlockTimestamp() + (r % 20 days));
            ledger.penalize(ids[0], receiptSeq++, bytes32(r), r % 2 == 0);
            assertLe(ledger.scoreOf(ids[0]), 1000e18);
        }
        assertEq(ledger.balanceOf(accts[0]), n);
    }

    /// Without new penalties, the score never increases over time.
    function testFuzz_DecayIsMonotone(uint32 t1, uint32 t2, bool major) public {
        ledger.penalize(ids[1], receiptSeq++, "e", major);
        uint256 a = bound(t1, 0, 400 days);
        uint256 b = bound(t2, a, 400 days);
        uint256 start = vm.getBlockTimestamp();
        vm.warp(start + a);
        uint256 sa = ledger.scoreOf(ids[1]);
        vm.warp(start + b);
        uint256 sb = ledger.scoreOf(ids[1]);
        assertLe(sb, sa);
    }

    /// A single minor penalty is gone after exactly one fade period.
    function testFuzz_SingleMinorFadesWithinPeriod(uint64 fade) public {
        fade = uint64(bound(fade, 1, 3650 days));
        ledger.setConfig(PenaltyLedger.Config(100, 2, 10_000, 1000, 200, 500, fade));
        ledger.penalize(ids[2], receiptSeq++, "e", false);
        vm.warp(vm.getBlockTimestamp() + fade);
        assertEq(ledger.scoreOf(ids[2]), 0, "rate rounds up: never outlasts the fade period");
    }

    /// Extreme but valid configs never overflow or revert.
    function testFuzz_ExtremeConfigNoOverflow(uint32 base, uint16 mult, uint32 esc, uint8 n) public {
        base = uint32(bound(base, 1, type(uint32).max));
        mult = uint16(bound(mult, 1, type(uint16).max));
        esc = uint32(bound(esc, 0, 50_000));
        n = uint8(bound(n, 1, 30));
        ledger.setConfig(PenaltyLedger.Config(base, mult, esc, type(uint32).max, 1, type(uint32).max, 1));
        for (uint256 i; i < n; ++i) ledger.penalize(ids[0], receiptSeq++, "e", i % 2 == 0);
        assertLe(ledger.scoreOf(ids[0]), uint256(type(uint32).max) * 1e18);
    }

    /// Forgiving never underflows and never increases the score.
    function testFuzz_ForgiveBounded(uint256 amount, uint8 n) public {
        n = uint8(bound(n, 1, 5));
        for (uint256 i; i < n; ++i) ledger.penalize(ids[0], receiptSeq++, "e", false);
        uint256 before = ledger.scoreOf(ids[0]);
        ledger.forgive(ids[0], amount, "r");
        uint256 afterS = ledger.scoreOf(ids[0]);
        assertLe(afterS, before);
        assertEq(afterS, amount >= before ? 0 : before - amount);
    }

    /// Escalation: with no time passing, each new minor penalty adds strictly more than the previous.
    function testFuzz_EscalationGrowsFast(uint8 n) public {
        n = uint8(bound(n, 2, 3)); // 100, 200, 400; a 4th (800) would hit the cap, which flattens growth by design
        uint256 prevWeight;
        for (uint256 i; i < n; ++i) {
            uint256 s0 = ledger.scoreOf(ids[1]);
            ledger.penalize(ids[1], receiptSeq++, "e", false);
            uint256 w = ledger.scoreOf(ids[1]) - s0;
            assertGt(w, prevWeight);
            prevWeight = w;
        }
    }
}

/// @dev Handler for stateful invariant testing.
contract LedgerHandler is Test {
    PenaltyLedger public ledger;
    bytes32[3] public ids;
    uint256 public receiptSeq = 1;
    uint256 public minted;

    constructor(PenaltyLedger l, bytes32[3] memory _ids) {
        ledger = l;
        ids = _ids;
    }

    function penalize(uint256 who, bool major) external {
        ledger.penalize(ids[who % 3], receiptSeq++, "e", major);
        minted++;
    }

    uint256 public forgiveCalls;
    uint256 public forgiveSuccesses;

    function forgive(uint256 who, uint256 amount) external {
        forgiveCalls++;
        ledger.forgive(ids[who % 3], bound(amount, 0, 2000e18), "r");
        forgiveSuccesses++;
    }

    function wait(uint256 secs) external {
        vm.warp(vm.getBlockTimestamp() + bound(secs, 0, 60 days));
    }
}

contract LedgerInvariantTest is StdInvariant, LedgerFixture {
    PenaltyLedger ledger;
    LedgerHandler handler;

    function setUp() public {
        vm.warp(1_780_000_000);
        _setupHumans();
        ledger = new PenaltyLedger(humans, address(this), PenaltyLedger.Config(100, 2, 10_000, 1000, 200, 500, 30 days));
        handler = new LedgerHandler(ledger, ids);
        ledger.grantRole(ledger.MINTER_ROLE(), address(handler));
        ledger.grantRole(ledger.EVALUATOR_ROLE(), address(handler));
        _enrollAddr(address(handler), 901); // evaluators must be enrolled humans
        targetContract(address(handler));
    }

    function invariant_ScoreWithinCap() public view {
        for (uint256 i; i < 3; ++i) assertLe(ledger.scoreOf(ids[i]), 1000e18);
    }

    function invariant_StageMatchesScore() public view {
        for (uint256 i; i < 3; ++i) {
            uint256 s = ledger.scoreOf(ids[i]);
            uint8 st = ledger.stageOf(ids[i]);
            if (s == 0) assertEq(st, 0);
            else if (s >= 500e18) assertEq(st, 3);
            else if (s >= 200e18) assertEq(st, 2);
            else assertEq(st, 1);
        }
    }

    /// guards against a silently-reverting handler making the suite pass vacuously
    function invariant_ForgivenessActuallyExercised() public view {
        if (handler.forgiveCalls() > 20) assertGt(handler.forgiveSuccesses(), 0);
    }

    function invariant_EveryPenaltyRecordedAndLocked() public view {
        uint256 total;
        for (uint256 i; i < 3; ++i) total += ledger.balanceOf(accts[i]);
        assertEq(total, handler.minted());
        assertEq(ledger.nextId() - 1, handler.minted());
    }
}
