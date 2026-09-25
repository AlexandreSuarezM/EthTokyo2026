// "Set user auth" + "after human-in-the-loop auth": produces personhood proofs.
import { AbiCoder, keccak256, solidityPacked, id } from 'ethers';

const coder = AbiCoder.defaultAbiCoder();

/**
 * LOCAL ONLY. Produces proofs accepted by MockWorldID. Mirrors the property of a real proof:
 * bound to exactly one signal and one human (nullifier).
 */
export class MockWorldIDProver {
  constructor(externalNullifierHash) {
    this.ext = BigInt(externalNullifierHash);
  }

  /** A human's nullifier: stable per (human, app, action). Here derived from a secret seed. */
  nullifierFor(user) {
    return BigInt(id(`human:${user.name}`)) >> 8n;
  }

  async prove(signal, user) {
    const root = 42n;
    const nullifier = this.nullifierFor(user);
    const signalHash = BigInt(keccak256(solidityPacked(['bytes32'], [signal]))) >> 8n;
    const p0 = BigInt(keccak256(coder.encode(['uint256', 'uint256', 'uint256', 'uint256'], [root, signalHash, nullifier, this.ext])));
    return { root, nullifier, proof: [p0, 0n, 0n, 0n, 0n, 0n, 0n, 0n] };
  }
}

/**
 * PRODUCTION SHAPE (not wired): the proof comes from the user's World App.
 *  1. Backend creates a request with IDKit: app_id, action "hitl-approve",
 *     signal = the bytes32 the contract expects (enrollSignal / liveSignal).
 *  2. User scans / taps in World App; for high tiers the app requires Face Auth.
 *  3. The returned { merkle_root, nullifier_hash, proof } is unpacked into HumanProof
 *     and passed to HumanRegistry.enroll or ValidationMark.validate.
 * Check the World ID version you target: 3.x nullifiers are stable per action (this design
 * relies on that); 4.0 changes nullifier semantics.
 */
export class WorldIDProver {
  constructor({ appId, action = 'hitl-approve', requestProof }) {
    this.appId = appId;
    this.action = action;
    this.requestProof = requestProof; // async (appId, action, signal, user) => raw IDKit result
  }

  async prove(signal, user) {
    if (!this.requestProof) throw new Error('WorldIDProver: supply requestProof (IDKit bridge)');
    const r = await this.requestProof(this.appId, this.action, signal, user);
    const unpacked = coder.decode(['uint256[8]'], r.proof)[0];
    return { root: BigInt(r.merkle_root), nullifier: BigInt(r.nullifier_hash), proof: [...unpacked] };
  }
}
