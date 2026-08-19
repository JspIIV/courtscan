// Runs probes against Assay and records what came back, including what did not.
//
// The whole point of this harness is the second half. A probe that agrees
// writes itself into the contract and needs nothing from here. A probe that
// times out, is never voted on, or errors has its state change discarded, so
// the only place its outcome exists is the transaction receipt. This reads that
// receipt and reports it back, citing the hash, which is the only claim anybody
// has to take on trust and the one thing they can check for themselves.
//
//   SWEEP=quick node scripts/assay_sweep.mjs
//   ASSAY=0x... SOURCE=https://... node scripts/assay_sweep.mjs
import { Wallet } from 'ethers';
import { createClient, createAccount } from 'genlayer-js';
import { testnetAsimov } from 'genlayer-js/chains';
import fs from 'fs';
import os from 'os';
import path from 'path';

const ADDR = process.env.ASSAY || '0xbaBf2796De591Dfe9289b60bE68f4426449676fA';
const SOURCE = process.env.SOURCE || 'https://raw.githubusercontent.com/JspIIV/warden-evidence/main/window-1.md';
const KS = process.env.ASSAY_KEYSTORE_DIR || path.join(os.homedir(), '.genlayer', 'keystores');
const KEY = process.env.ASSAY_KEY || 'padv';
// Never a literal here. These are throwaway test keys, but a password
// committed to a public repository teaches the next reader the wrong habit.
const PASS = process.env.ASSAY_KEYSTORE_PASS || '';

// A sweep is a list of [evidence_chars, bound_fields, mode]. The default walks
// the size axis at one bound field, because size is the axis that was already
// seen to break a real contract and the cheapest one to establish first.
const SWEEPS = {
  quick: [
    [500, 1, 'STRICT'],
    [3500, 1, 'STRICT'],
    [8000, 1, 'STRICT'],
  ],
  size: [
    [0, 1, 'STRICT'],
    [500, 1, 'STRICT'],
    [1500, 1, 'STRICT'],
    [3500, 1, 'STRICT'],
    [6000, 1, 'STRICT'],
    [8000, 1, 'STRICT'],
    [12000, 1, 'STRICT'],
  ],
  binding: [
    [1500, 1, 'STRICT'],
    [1500, 2, 'STRICT'],
    [1500, 3, 'STRICT'],
    [1500, 4, 'STRICT'],
  ],
  modes: [
    [1500, 2, 'STRICT'],
    [1500, 2, 'COMPARATIVE'],
    [3500, 2, 'STRICT'],
    [3500, 2, 'COMPARATIVE'],
  ],
};

const plan = SWEEPS[process.env.SWEEP || 'quick'];
if (!plan) {
  console.error(`no such sweep. try one of: ${Object.keys(SWEEPS).join(', ')}`);
  process.exit(1);
}

const wallet = await Wallet.fromEncryptedJson(fs.readFileSync(`${KS}/${KEY}.json`, 'utf8'), PASS);
const client = createClient({ chain: testnetAsimov, account: createAccount(wallet.privateKey) });
const reader = createClient({ chain: testnetAsimov });

const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));
const transient = (e) => /backpressure|not currently accepting|fetch failed|ECONNRESET|socket|timeout|Server busy|Rate limit|-32006|-32029|-32603/i
  .test(String(e?.details || e?.message || e));

async function retry(label, fn, attempts = 5) {
  let last;
  for (let i = 1; i <= attempts; i++) {
    try { return await fn(); } catch (e) {
      if (!transient(e)) throw e;
      last = e;
      console.log(`     ..  ${label}: retry ${i}/${attempts}`);
      await sleep(15 * i);
    }
  }
  throw last;
}

const read = async (fn, args = []) => {
  const raw = await retry(`read ${fn}`, () => reader.readContract({ address: ADDR, functionName: fn, args }));
  try { return JSON.parse(raw); } catch { return raw; }
};

// What the network says happened, in its own words rather than ours.
//
// `waitForTransactionReceipt` serialises with JSON.stringify and dies on the
// BigInt fields the node returns, so the transaction is read back directly.
async function outcomeOf(hash) {
  for (let i = 0; i < 60; i++) {
    try {
      const raw = await reader.getTransaction({ hash });
      const tx = JSON.parse(JSON.stringify(raw, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
      const status = String(tx.statusName || '');
      if (status === 'FINALIZED' || status === 'ACCEPTED') {
        return {
          status,
          result: String(tx.resultName || ''),
          execution: String(tx.txExecutionResultName || ''),
          rounds: Number(tx.numOfRounds || 0),
        };
      }
    } catch { /* the node has not caught up; ask again */ }
    await sleep(10);
  }
  return { status: 'UNSEEN', result: '', execution: '', rounds: 0 };
}

/// Which of the reportable outcomes this was, `null` when the round agreed, or
/// `unknown` when the network has not said yet.
///
/// That last case is not a formality. The first sweep waited ten minutes on a
/// probe, got no answer, and this function called it REVERTED, which would have
/// put a claim on chain that nothing supported: a transaction still settling
/// looks exactly like one that never ran. A measurement tool that guesses when
/// it does not know is worse than no measurement tool. So it reports nothing
/// and says so.
function classify(seen, agreedBefore, agreedAfter) {
  if (agreedAfter > agreedBefore) return null;          // the round wrote itself in
  if (seen.result === 'TIMEOUT') return 'TIMEOUT';
  if (seen.execution === 'NOT_VOTED') return 'NOT_VOTED';
  if (seen.execution === 'FINISHED_WITH_ERROR') return 'FINISHED_WITH_ERROR';
  if (seen.status === 'UNSEEN') return 'unknown';
  return 'REVERTED';
}

console.log('assay ', ADDR);
console.log('source', SOURCE);
console.log('sweep ', process.env.SWEEP || 'quick', `(${plan.length} probes)\n`);

const log = [];

for (const [size, bound, mode] of plan) {
  const label = `${String(size).padStart(5)} chars, ${bound} bound, ${mode}`;
  console.log(`>> ${label}`);

  const before = (await read('get_stats')).rounds_that_agreed;
  let hash;
  try {
    hash = await retry('probe', () => client.writeContract({
      address: ADDR, functionName: 'probe',
      args: [SOURCE, String(size), String(bound), mode], value: 0n,
    }));
  } catch (e) {
    console.log(`   could not even send it: ${String(e?.message || e).slice(0, 120)}\n`);
    continue;
  }
  console.log(`   ${hash}`);

  const seen = await outcomeOf(hash);
  const after = (await read('get_stats')).rounds_that_agreed;
  const failure = classify(seen, before, after);

  if (!failure) {
    console.log(`   AGREED   status ${seen.status}, ${seen.rounds} round(s)\n`);
    log.push({ size, bound, mode, hash, outcome: 'AGREED' });
    continue;
  }

  if (failure === 'unknown') {
    console.log('   UNKNOWN  the network has not said what happened to this one yet.');
    console.log('            Nothing is being recorded for it: an unfinished round and a');
    console.log(`            round that never ran look the same from here. ${hash}
`);
    log.push({ size, bound, mode, hash, outcome: 'unknown' });
    continue;
  }

  console.log(`   ${failure.padEnd(8)} status ${seen.status}, result ${seen.result || '-'}, `
    + `execution ${seen.execution || '-'}`);

  // Reported in a plain write, with no consensus round of its own, so that
  // recording a failure cannot itself fail for the reason being recorded.
  try {
    const note = `status ${seen.status}, result ${seen.result || '-'}, execution ${seen.execution || '-'}`;
    const reportHash = await retry('report', () => client.writeContract({
      address: ADDR, functionName: 'report_failure',
      args: [hash, SOURCE, String(size), String(bound), mode, failure, note], value: 0n,
    }));
    console.log(`   reported ${reportHash}\n`);
  } catch (e) {
    console.log(`   could not report it: ${String(e?.message || e).slice(0, 120)}\n`);
  }
  log.push({ size, bound, mode, hash, outcome: failure, seen });
}

// ---- what the run found ----------------------------------------------------

const frontier = await read('get_frontier');
console.log('--- the frontier so far ---');
for (const row of frontier.frontier) {
  console.log(`  ${row.mode.padEnd(11)} ${row.bound_fields} bound  `
    + `largest agreed ${String(row.largest_agreed ?? '-').padStart(6)}  `
    + `smallest failed ${String(row.smallest_failed ?? '-').padStart(6)}  `
    + `(${row.observations} observation${row.observations === 1 ? '' : 's'})`);
}

fs.mkdirSync('run', { recursive: true });
fs.writeFileSync('run/assay-sweep.json', JSON.stringify({ assay: ADDR, source: SOURCE, log }, null, 2));
console.log(`\n${log.length} probe(s) recorded`);
console.log(`https://explorer-asimov.genlayer.com/address/${ADDR}`);
