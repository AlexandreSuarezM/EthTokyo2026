// Loads every environment preset on a fresh local chain and prints the permissions each preset generates.
import { spawn } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { JsonRpcProvider, HDNodeWallet, Wallet, id } from 'ethers';
import { deployAll, applyEnvironment, permId } from './src/contracts.js';

const PORT = 8547;
const key = (i) => HDNodeWallet.fromPhrase('test test test test test test test test test test test junk', undefined, `m/44'/60'/0'/0/${i}`).privateKey;
const dir = new URL('../environments/', import.meta.url);
const anvil = spawn(process.env.ANVIL ?? 'anvil', ['--port', String(PORT), '--silent'], { stdio: 'ignore' });
try {
  const provider = new JsonRpcProvider(`http://127.0.0.1:${PORT}`, undefined, { cacheTimeout: -1 });
  for (let i = 0; ; i++) { try { await provider.getBlockNumber(); break; } catch { if (i > 50) throw new Error('no anvil'); await new Promise((r) => setTimeout(r, 100)); } }
  const admin = new Wallet(key(0), provider), operator = new Wallet(key(1), provider);
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    const env = JSON.parse(readFileSync(new URL(f, dir), 'utf8'));
    const c = await deployAll({ admin, operator, penalties: env.penalties });
    const { feeToken } = await applyEnvironment(c, admin, env, { feePayer: operator });
    const cfg = await c.ledger.config();
    const pol = await c.perms.policy();
    console.log(`\n${env.name}: liveProofTier=${pol.liveProofTier} selfApproval=${pol.allowSelfApproval} appealWindow=${Number(await c.receipts.appealWindow()) / 86400}d` +
      ` | penalty base=${cfg.base} x${cfg.majorMultiplier} +${Number(cfg.escalationBps) / 100}% cap=${cfg.maxScore} noAI@${cfg.stage2At} ban@${cfg.stage3At} fade=${Number(cfg.fadePeriod) / 86400}d` +
      `${feeToken ? ` | fees on (relayer allowance ok=${(await feeToken.allowance(operator.address, await c.receipts.getAddress())) > 0n})` : ''}`);
    for (const name of Object.keys(env.presets)) {
      const [pPerms, pValues] = await c.perms.presetOf(id(name));
      const p = { perms: pPerms, values: pValues };
      const names = Object.keys(env.presets[name].grants);
      const ok = names.every((n, i) => p.perms[i] === permId(n) && Number(p.values[i]) === env.presets[name].grants[n]);
      console.log(`  preset ${name.padEnd(16)} ${ok ? 'ok' : 'MISMATCH'}  ${names.map((n, i) => `${n}=${p.values[i]}`).join(' ')}`);
    }
  }
} finally { anvil.kill(); }
