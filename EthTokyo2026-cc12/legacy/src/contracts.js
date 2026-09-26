// Deployment from Foundry build artifacts (run `forge build` in contracts/ first).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ContractFactory, Contract, id, parseUnits, ZeroAddress } from 'ethers';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export function artifact(file, name) {
  const j = JSON.parse(readFileSync(join(root, 'contracts', 'out', file, `${name}.json`), 'utf8'));
  return { abi: j.abi, bytecode: j.bytecode.object };
}

async function deploy(signer, file, name, args = []) {
  const { abi, bytecode } = artifact(file, name);
  const c = await new ContractFactory(abi, bytecode, signer).deploy(...args);
  await c.waitForDeployment();
  return c;
}

export const DEFAULT_PENALTIES = { base: 100, majorMultiplier: 2, escalationPct: 100, maxScore: 1000, stage2At: 200, stage3At: 500, fadeDays: 30 };

export function penaltyConfig(p = DEFAULT_PENALTIES) {
  return {
    base: p.base,
    majorMultiplier: p.majorMultiplier,
    escalationBps: Math.round(p.escalationPct * 100),
    maxScore: p.maxScore,
    stage2At: p.stage2At,
    stage3At: p.stage3At,
    fadePeriod: BigInt(Math.round(p.fadeDays * 86400)),
  };
}

/**
 * @param admin     org admin (configures; holds no ruling role)
 * @param operator  orchestrator / relayer (consumes AI quotas, pays gas and fees)
 * @param worldIdRouter real World ID router; if omitted a MockWorldID is deployed
 */
export async function deployAll({ admin, operator, worldIdRouter, penalties, appId = 'app_hitl_demo', action = 'hitl-approve' }) {
  const router = worldIdRouter ?? (await (await deploy(admin, 'Mocks.sol', 'MockWorldID')).getAddress());
  const verifier = await deploy(admin, 'WorldIDVerifier.sol', 'WorldIDVerifier', [router, appId, action]);
  const humans = await deploy(admin, 'HumanRegistry.sol', 'HumanRegistry', [await verifier.getAddress(), admin.address]);
  const perms = await deploy(admin, 'PermissionRegistry.sol', 'PermissionRegistry', [await humans.getAddress(), admin.address]);
  const receipts = await deploy(admin, 'ValidationReceipts.sol', 'ValidationReceipts', [
    await humans.getAddress(), await perms.getAddress(), await verifier.getAddress(), admin.address,
  ]);
  const ledger = await deploy(admin, 'PenaltyLedger.sol', 'PenaltyLedger', [await humans.getAddress(), admin.address, penaltyConfig(penalties)]);

  await (await perms.grantRole(await perms.SANCTIONER_ROLE(), await receipts.getAddress())).wait();
  await (await perms.grantRole(await perms.OPERATOR_ROLE(), operator.address)).wait();
  await (await perms.setLedger(await ledger.getAddress())).wait();
  await (await receipts.setLedger(await ledger.getAddress())).wait();
  await (await ledger.grantRole(await ledger.MINTER_ROLE(), await receipts.getAddress())).wait();
  return { verifier, humans, perms, receipts, ledger, router };
}

/** Grant ruling roles. Holders must be ENROLLED humans (the contracts enforce it). */
export async function grantRulingRoles({ receipts, ledger }, admin, { forensics = [], appeals = [], evaluators = [] }) {
  for (const a of forensics) await (await receipts.connect(admin).grantRole(await receipts.FORENSICS_ROLE(), a)).wait();
  for (const a of appeals) await (await receipts.connect(admin).grantRole(await receipts.APPEALS_ROLE(), a)).wait();
  for (const a of evaluators) await (await ledger.connect(admin).grantRole(await ledger.EVALUATOR_ROLE(), a)).wait();
}

export const permId = (name) => id(name); // keccak256("REPO_TIER") etc. — matches the contract
export const repoId = (name) => id(name);

/** Apply an environment file: policy, receipts windows, penalty rules, repos, presets, fees. */
export async function applyEnvironment({ perms, receipts, ledger }, admin, env, { feePayer } = {}) {
  const p = env.policy;
  await (await perms.setPolicy({
    liveProofTier: p.liveProofTier,
    allowSelfApproval: p.allowSelfApproval,
    flagCooldown: BigInt(Math.round(p.flagCooldownDays * 86400)),
    flagStrikeWindow: BigInt(Math.round(p.flagStrikeWindowDays * 86400)),
    baselessFlagLimit: p.baselessFlagLimit,
    maxTierForSelfie: p.maxTierForSelfie ?? 0,
  })).wait();

  const r = env.receipts;
  await (await receipts.setConfig(BigInt(r.liabilityWindowDays * 86400), BigInt(r.appealWindowDays * 86400), r.attester || ZeroAddress)).wait();
  await (await ledger.setConfig(penaltyConfig(env.penalties))).wait();

  let feeToken = null;
  if (env.fees) {
    feeToken = env.fees.token === 'mock' ? await deploy(admin, 'Mocks.sol', 'MockUSD') : new Contract(env.fees.token, artifact('IERC20.sol', 'IERC20').abi, admin);
    const tiers = Object.keys(env.fees.byTier).map(Number);
    const amounts = Object.values(env.fees.byTier).map((v) => parseUnits(v, 18));
    await (await receipts.setFees(await feeToken.getAddress(), admin.address, tiers, amounts)).wait();
    // fees are paid by whoever submits validate() (the relayer); fund + approve it for the demo
    if (env.fees.token === 'mock' && feePayer) {
      await (await feeToken.mint(feePayer.address, parseUnits('1000', 18))).wait();
      await (await feeToken.connect(feePayer).approve(await receipts.getAddress(), 2n ** 256n - 1n)).wait();
    }
  }

  for (const repo of env.repos) await (await perms.setRepo(repoId(repo.id), repo.tier, repo.requiredApprovals)).wait();
  for (const [name, preset] of Object.entries(env.presets)) {
    const names = Object.keys(preset.grants);
    await (await perms.definePreset(id(name), names.map(permId), names.map((n) => BigInt(preset.grants[n])), BigInt(preset.durationDays * 86400))).wait();
  }
  return { feeToken };
}
