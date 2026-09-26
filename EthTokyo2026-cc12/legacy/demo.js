// End-to-end run on a local chain.
//   users:        alice = coder (prompts the AI)      bob = validator
//   system roles: forensics (audits receipts), appeals (second reviewer), evaluator (forgives)
//                 — all three are enrolled humans, as the contracts require.
// Usage: forge build && node demo.js [environments/<file>.json]
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { JsonRpcProvider, HDNodeWallet, Wallet, id } from 'ethers';
import { deployAll, applyEnvironment, grantRulingRoles, repoId } from './src/contracts.js';
import { Zone1, User } from './src/zone1.js';
import { SessionContext } from './src/context.js';
import { MockModel } from './src/adapters/model.js';
import { MockWorldIDProver } from './src/adapters/humanProof.js';

const ANVIL = process.env.ANVIL ?? 'anvil';
const PORT = 8546;
const MNEMONIC = 'test test test test test test test test test test test junk'; // anvil default, local only
const envPath = process.argv[2] ?? new URL('../environments/team-default.json', import.meta.url);
const env = JSON.parse(readFileSync(envPath, 'utf8'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const key = (i) => HDNodeWallet.fromPhrase(MNEMONIC, undefined, `m/44'/60'/0'/0/${i}`).privateKey;
const PERM_NAMES = Object.fromEntries(['REPO_TIER', 'APPROVE_DEPTH', 'SOLO_APPROVE', 'AI_SUBMIT', 'MERGE_PROTECTED', 'GRANT', 'FLAG'].map((n) => [id(n), n]));
let IFACES = [];
const reason = (e) => {
  const data = e?.data ?? e?.info?.error?.data;
  for (const i of IFACES) {
    try { const d = i.parseError(data); if (d) return `${d.name}(${d.args.map((a) => PERM_NAMES[a] ?? (String(a).length > 20 ? String(a).slice(0, 10) + '…' : a)).join(', ')})`; } catch {}
  }
  return e?.shortMessage ?? String(e);
};
const expectFail = async (label, fn) => {
  try { await fn(); console.log(`  ✗ ${label}: went through (unexpected)`); } catch (e) { console.log(`  ✓ ${label}: ${reason(e)}`); }
};
const days = (s) => (Number(s) / 86400).toFixed(1);

async function main() {
  const anvil = spawn(ANVIL, ['--port', String(PORT), '--silent'], { stdio: 'ignore' });
  try {
    const provider = new JsonRpcProvider(`http://127.0.0.1:${PORT}`, undefined, { pollingInterval: 100, cacheTimeout: -1 });
    for (let i = 0; ; i++) { try { await provider.getBlockNumber(); break; } catch { if (i > 50) throw new Error('anvil did not start'); await sleep(100); } }
    const warp = async (secs) => { await provider.send('evm_increaseTime', [Math.ceil(Number(secs))]); await provider.send('evm_mine', []); };

    const admin = new Wallet(key(0), provider);
    const operator = new Wallet(key(1), provider);
    const forensics = new Wallet(key(4), provider);
    const appeals = new Wallet(key(5), provider);
    const evaluator = new Wallet(key(6), provider);

    console.log(`\n== deploy + environment "${env.name}"`);
    const c = await deployAll({ admin, operator, penalties: env.penalties });
    await applyEnvironment(c, admin, env, { feePayer: operator });
    IFACES = [c.receipts.interface, c.ledger.interface, c.perms.interface, c.humans.interface];
    const pen = env.penalties;
    console.log(`  penalties: ${pen.base}/mistake (major x${pen.majorMultiplier}), +${pen.escalationPct}% of current score, cap ${pen.maxScore}, ` +
      `stage 2 (no AI) at ${pen.stage2At}, stage 3 (banned) at ${pen.stage3At}, ${pen.base} points fade per ${pen.fadeDays} days`);

    const z = new Zone1({ contracts: c, provider, admin, operator, forensics, evaluator, prover: new MockWorldIDProver(await c.verifier.externalNullifierHash()) });

    console.log('\n== ZONE 1 / load users + set user auth (World ID enrollment)');
    const [alice, bob] = z.loadUsers([
      { name: 'alice', preset: 'coder', privateKey: key(2) },
      { name: 'bob', preset: 'reviewer', privateKey: key(3) },
    ]);
    for (const u of [alice, bob]) await z.setUserAuth(u);
    // ruling roles must be held by enrolled humans
    for (const [name, w] of [['forensic', forensics], ['appeals', appeals], ['evaluat', evaluator]]) {
      await z.setUserAuth(new User({ name, wallet: w, preset: null }));
    }
    // forensics ALSO gets the appeals role, so the demo proves the contract blocks it from hearing
    // appeals of its own rulings by HUMAN identity (not merely by a missing role)
    await grantRulingRoles(c, admin, { forensics: [forensics.address], appeals: [appeals.address, forensics.address], evaluators: [evaluator.address] });

    console.log('\n== ZONE 1 / load model');
    z.loadModel(new MockModel());
    console.log(`  model ${z.model.modelId}`);

    console.log('\n== validations: each produces a RECEIPT, never a token');
    let first = true;
    const r1 = await z.runSession({
      submitter: alice, reviewer: bob, repo: 'acme/web', target: 'src/handler.ts', input: 'add input validation',
      review: async () => (first ? ((first = false), { decision: 'deny', newInput: 'missing test for null input' }) : { decision: 'accept' }),
    });
    const r2 = await z.runSession({ submitter: alice, reviewer: bob, repo: 'acme/payments', target: 'src/refund.ts', input: 'cap refunds', review: async () => ({ decision: 'accept' }) });
    const r3 = await z.runSession({ submitter: alice, reviewer: bob, repo: 'acme/web', target: 'src/cart.ts', input: 'fix rounding', review: async () => ({ decision: 'accept' }) });
    const r4 = await z.runSession({ submitter: alice, reviewer: bob, repo: 'acme/web', target: 'src/auth.ts', input: 'refresh tokens', review: async () => ({ decision: 'accept' }) });
    console.log(`  bob holds ${await c.ledger.balanceOf(bob.address)} tokens after 4 validations`);

    console.log('\n== attack checks');
    await expectFail('forensics cannot mint directly on the ledger', () => c.ledger.connect(forensics).penalize.staticCall(bob.humanId, r1.receiptId, id('x'), false));
    const sock = Wallet.createRandom(provider);
    await (await admin.sendTransaction({ to: sock.address, value: 10n ** 17n })).wait();
    await grantRulingRoles(c, admin, { forensics: [sock.address] });
    await expectFail('unenrolled sock-puppet with forensics role cannot rule', () => c.receipts.connect(sock).audit.staticCall(r1.receiptId, true, id('x'), false));

    const show = async (label) => {
      const s = await z.standing(bob);
      console.log(`  ${label.padEnd(34)} bob: score ${String(s.score).padStart(6)}  stage ${s.stage} (${s.stageName})  penalty tokens ${s.penalties}`);
    };

    console.log(`\n== forensics (appeal window ${env.receipts.appealWindowDays} days)`);
    await z.audit(r1.receiptId, true, 'post-release review: handler behaves correctly');
    await show('after correct audit');

    await z.audit(r2.receiptId, false, 'INC-102: refund cap bypass');
    await show('ruled wrong, before due process');
    await z.appeal(bob, r2.receiptId, 'the bypass path was outside the diff I was shown');
    await expectFail('forensics cannot hear the appeal of its own ruling', () => c.receipts.connect(forensics).resolveAppeal.staticCall(r2.receiptId, true));
    await z.resolveAppeal(appeals, r2.receiptId, false);
    await show('mistake 1 (minor)');

    await z.audit(r3.receiptId, false, 'INC-107: rounding error in totals');
    await expectFail('penalty not minted while appeal window open', () => c.receipts.finalize.staticCall(r3.receiptId));
    await warp(env.receipts.appealWindowDays * 86400 + 1);
    await z.finalize(r3.receiptId);
    await show('mistake 2 (minor, escalated)');
    try {
      await z.runSession({ submitter: bob, reviewer: alice, repo: 'acme/web', target: 'x.ts', input: 'x', review: async () => ({ decision: 'accept' }) });
      console.log('  ✗ bob used the AI in stage 2 (unexpected)');
    } catch (e) { console.log(`  ✓ stage 2 — bob's AI access blocked: ${reason(e)}`); }

    await z.audit(r4.receiptId, false, 'INC-111: session tokens never expire', { major: true });
    await warp(env.receipts.appealWindowDays * 86400 + 1);
    await z.finalize(r4.receiptId);
    await show('mistake 3 (MAJOR, escalated)');
    await expectFail('stage 3 — banned bob cannot validate', async () => {
      const s = new SessionContext({ sessionId: id('banned'), repo: 'acme/web', target: 'y.ts', task: 'x' });
      const ctx = s.restore();
      await z.afterHitlAuth({ reviewer: bob, submitter: alice, repo: 'acme/web', session: s, ctx, submission: await z.model.submit({ input: 'x', context: ctx }), rounds: 0 });
    });
    await expectFail('penalty token cannot be transferred', () => c.ledger.connect(bob.wallet).transferFrom.staticCall(bob.address, alice.address, 1n));

    console.log('\n== recovery');
    await z.forgive(bob, 300, 'completed secure-review training');
    await show('after evaluator forgiveness');
    const toStage1 = await c.ledger.secondsUntilBelow(bob.humanId, pen.stage2At);
    await warp(toStage1);
    await show(`+${days(toStage1)} days of fading`);
    const { rateWad } = await c.ledger.accountOf(bob.humanId);
    const toClean = (await c.ledger.scoreOf(bob.humanId)) / rateWad + 1n; // seconds until exactly 0
    await warp(toClean);
    await show(`+${days(toClean)} more days`);

    const md = await z.penaltyMetadata(1n);
    console.log(`\n== penalty token #1 metadata: "${md.name}" ` + md.attributes.filter((a) => !['human', 'evidence'].includes(a.trait_type)).map((a) => `${a.trait_type}=${a.value}`).join(', '));

    const events = await z.track(0);
    console.log(`\n== tracked ${events.length} accountability events`);
    for (const e of events) console.log(`  #${String(e.block).padEnd(3)} ${e.type.padEnd(14)} ${e.args.map((x) => (x.length > 20 ? x.slice(0, 10) + '…' : x)).join(' ')}`);
    void repoId;
  } finally {
    anvil.kill();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
