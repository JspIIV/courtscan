// Runs COMPOSE probes against Assay: rounds where validators must write a
// judgement under a clock, not choose from a list. The classify axis never
// broke a round; this is the axis the project always said was the real lever.
//
// Same honest second half as assay_sweep.mjs: a round that agrees writes itself
// in, a round that does not has its write discarded, so its outcome lives only
// in the receipt, which this reads and reports back citing the hash.
//
//   ASSAY=0x... SWEEP=trial node scripts/assay_compose_sweep.mjs
import { Wallet } from 'ethers';
import { createClient, createAccount } from 'genlayer-js';
import { testnetAsimov } from 'genlayer-js/chains';
import fs from 'fs'; import os from 'os'; import path from 'path'; import url from 'url';

const ROOT = path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const V2 = (() => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'run', 'assay-compose-deploy.json'), 'utf8')).address; } catch { return null; } })();
const ADDR = process.env.ASSAY || V2;
if (!ADDR) { console.error('no ASSAY address (set ASSAY= or deploy first)'); process.exit(1); }
// A document that actually describes conduct worth a supervisor judgement.
const SOURCE = process.env.SOURCE || 'https://raw.githubusercontent.com/JspIIV/warden-evidence/main/window-1.md';
const KS = process.env.ASSAY_KEYSTORE_DIR || path.join(os.homedir(), '.genlayer', 'keystores');
const KEY = process.env.ASSAY_KEY || 'padv';
const PASS = process.env.ASSAY_KEYSTORE_PASS || '';
if (!PASS) { console.error('set ASSAY_KEYSTORE_PASS'); process.exit(1); }

// A compose sweep is a list of [evidence_chars, compose_budget]. trial is a
// single demanding round, at the size and composition load that broke a real
// contract in the wild, to see whether this axis reproduces it at all.
const SWEEPS = {
  trial: [[8000, 4]],
  budget: [[3500, 1], [3500, 2], [3500, 3], [3500, 4]],
  size: [[1500, 4], [3500, 4], [6000, 4], [8000, 4], [12000, 4]],
  full: [
    [1500, 1], [1500, 4],
    [3500, 2], [3500, 4],
    [6000, 3], [6000, 4],
    [8000, 4], [12000, 4],
  ],
};
const plan = SWEEPS[process.env.SWEEP || 'trial'];
if (!plan) { console.error(`no such sweep. try: ${Object.keys(SWEEPS).join(', ')}`); process.exit(1); }

const wallet = await Wallet.fromEncryptedJson(fs.readFileSync(`${KS}/${KEY}.json`, 'utf8'), PASS);
const client = createClient({ chain: testnetAsimov, account: createAccount(wallet.privateKey) });
const reader = createClient({ chain: testnetAsimov });

const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));
const transient = (e) => /backpressure|not currently accepting|fetch failed|ECONNRESET|socket|timeout|Server busy|Rate limit|-32006|-32029|-32603/i
  .test(String(e?.details || e?.message || e));
async function retry(label, fn, attempts = 5) {
  let last;
  for (let i = 1; i <= attempts; i++) {
    try { return await fn(); } catch (e) { if (!transient(e)) throw e; last = e; console.log(`     ..  ${label}: retry ${i}/${attempts}`); await sleep(15 * i); }
  }
  throw last;
}
const read = async (fn, args = []) => {
  const raw = await retry(`read ${fn}`, () => reader.readContract({ address: ADDR, functionName: fn, args }));
  try { return JSON.parse(raw); } catch { return raw; }
};
async function outcomeOf(hash) {
  for (let i = 0; i < 90; i++) {
    try {
      const raw = await reader.getTransaction({ hash });
      const tx = JSON.parse(JSON.stringify(raw, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
      const status = String(tx.statusName || '');
      if (status === 'FINALIZED' || status === 'ACCEPTED') {
        return { status, result: String(tx.resultName || ''), execution: String(tx.txExecutionResultName || ''), rounds: Number(tx.numOfRounds || 0) };
      }
    } catch { /* not caught up */ }
    await sleep(10);
  }
  return { status: 'UNSEEN', result: '', execution: '', rounds: 0 };
}
function classify(seen, agreedBefore, agreedAfter) {
  if (agreedAfter > agreedBefore) return null;
  if (seen.result === 'TIMEOUT') return 'TIMEOUT';
  if (seen.execution === 'NOT_VOTED') return 'NOT_VOTED';
  if (seen.execution === 'FINISHED_WITH_ERROR') return 'FINISHED_WITH_ERROR';
  if (seen.status === 'UNSEEN') return 'unknown';
  return 'REVERTED';
}

console.log('assay ', ADDR);
console.log('source', SOURCE);
console.log('sweep ', process.env.SWEEP || 'trial', `(${plan.length} compose probe(s))\n`);
const log = [];

for (const [size, budget] of plan) {
  const label = `${String(size).padStart(5)} chars, compose_budget ${budget}`;
  console.log(`>> ${label}`);
  const before = (await read('get_stats')).rounds_that_agreed;
  let hash;
  try {
    hash = await retry('probe_compose', () => client.writeContract({
      address: ADDR, functionName: 'probe_compose', args: [SOURCE, String(size), String(budget)], value: 0n,
    }));
  } catch (e) { console.log(`   could not even send it: ${String(e?.message || e).slice(0, 120)}\n`); continue; }
  console.log(`   ${hash}`);

  const seen = await outcomeOf(hash);
  const after = (await read('get_stats')).rounds_that_agreed;
  const failure = classify(seen, before, after);

  if (!failure) { console.log(`   AGREED   status ${seen.status}, ${seen.rounds} round(s)\n`); log.push({ size, budget, hash, outcome: 'AGREED' }); continue; }
  if (failure === 'unknown') { console.log(`   UNKNOWN  the network has not said yet; recording nothing. ${hash}\n`); log.push({ size, budget, hash, outcome: 'unknown' }); continue; }

  console.log(`   ${failure.padEnd(8)} status ${seen.status}, result ${seen.result || '-'}, execution ${seen.execution || '-'}`);
  try {
    const note = `COMPOSE budget ${budget}: status ${seen.status}, result ${seen.result || '-'}, execution ${seen.execution || '-'}`;
    const reportHash = await retry('report', () => client.writeContract({
      address: ADDR, functionName: 'report_failure', args: [hash, SOURCE, String(size), String(budget), failure, note], value: 0n,
    }));
    console.log(`   reported ${reportHash}\n`);
  } catch (e) { console.log(`   could not report it: ${String(e?.message || e).slice(0, 120)}\n`); }
  log.push({ size, budget, hash, outcome: failure, seen });
}

const frontier = await read('get_frontier');
console.log('--- the frontier so far ---');
for (const row of frontier.frontier) {
  console.log(`  ${String(row.kind).padEnd(8)} ${String(row.mode).padEnd(11)} load ${row.load}  `
    + `largest agreed ${String(row.largest_agreed ?? '-').padStart(6)}  smallest failed ${String(row.smallest_failed ?? '-').padStart(6)}  `
    + `(${row.observations} obs)`);
}
fs.mkdirSync(path.join(ROOT, 'run'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'run', 'assay-compose-sweep.json'), JSON.stringify({ assay: ADDR, source: SOURCE, log }, null, 2));
console.log(`\n${log.length} compose probe(s) recorded`);
console.log(`https://explorer-asimov.genlayer.com/address/${ADDR}`);
