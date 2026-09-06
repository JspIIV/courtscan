// Run the three round shapes side by side and count what happens.
//
// The measurement is the receipt, not the contract's own record: a discarded
// round takes its state change with it, so the only place a failure is visible
// is here, in what the node reports back to whoever sent the transaction.
//
//   node scripts/round_shapes.mjs <contract> [runs per shape]
import { Wallet } from 'ethers';
import { createClient, createAccount } from 'genlayer-js';
import { studionet } from 'genlayer-js/chains';
import fs from 'fs';

const ADDR = process.argv[2];
const RUNS = Number(process.argv[3] || 8);
const OUT = 'results/round_shapes.json';
const KS = process.env.COURTSCAN_KEYSTORES
  || (process.env.HOME || process.env.USERPROFILE) + '/.genlayer/keystores';
const KEY = process.env.COURTSCAN_KEY || 'padv';
const PASS = process.env.COURTSCAN_PASS || '';

const w = await Wallet.fromEncryptedJson(
  fs.readFileSync(`${KS}/${KEY}.json`, 'utf8'), PASS);
const client = createClient({ chain: studionet, account: createAccount(w.privateKey) });

const SHAPES = ['deterministic', 'fetch_only', 'fetch_then_reason'];
const SOURCE = 'https://api.github.com/repos/JspIIV/courtscan';

const attempts = [];

for (const shape of SHAPES) {
  for (let n = 1; n <= RUNS; n++) {
    const started = Date.now();
    const attempt = { shape, run: n };
    try {
      const hash = await client.writeContract({
        address: ADDR, functionName: shape, args: [SOURCE], value: 0n,
      });
      attempt.tx = hash;
      const receipt = await client.waitForTransactionReceipt({
        hash, status: 'FINALIZED', retries: 200, interval: 5000,
      });
      const leader = receipt?.consensus_data?.leader_receipt?.[0];
      attempt.execution = leader?.execution_result ?? null;
      attempt.votes = receipt?.consensus_data?.validators?.map(v => v?.vote ?? '?') ?? [];
      // Landed means the state change survived. A round can report a return and
      // still have been thrown away, which is the whole reason Courtscan exists,
      // so this is read from the payload rather than from the status word.
      // The payload is a JSON string holding a JSON string. Testing the raw
      // text for "ok": true misses it, because every quote inside is escaped,
      // and every run then reads as lost. Unwrap it properly instead.
      const readable = leader?.result?.payload?.readable ?? '';
      let parsed = null;
      try { parsed = JSON.parse(JSON.parse(readable)); } catch { parsed = null; }
      attempt.landed = parsed?.ok === true;
      attempt.returned = parsed ? JSON.stringify(parsed).slice(0, 120) : String(readable).slice(0, 120);
    } catch (e) {
      attempt.execution = 'SEND_FAILED';
      attempt.landed = false;
      attempt.error = String(e && (e.details || e.message) || e).slice(0, 160);
    }
    attempt.seconds = Math.round((Date.now() - started) / 1000);
    attempts.push(attempt);
    console.log(`${shape.padEnd(18)} ${String(n).padStart(2)}/${RUNS}  ` +
      `${attempt.landed ? 'landed ' : 'LOST   '} ${String(attempt.execution).padEnd(16)} ` +
      `${attempt.seconds}s  votes ${JSON.stringify(attempt.votes ?? [])}`);
  }
}

const summary = {};
for (const shape of SHAPES) {
  const mine = attempts.filter(a => a.shape === shape);
  const landed = mine.filter(a => a.landed);
  summary[shape] = {
    attempted: mine.length,
    landed: landed.length,
    lost: mine.length - landed.length,
    median_seconds: mine.map(a => a.seconds).sort((a, b) => a - b)[Math.floor(mine.length / 2)],
    outcomes: mine.reduce((acc, a) => (acc[a.execution] = (acc[a.execution] || 0) + 1, acc), {}),
  };
}

fs.mkdirSync('results', { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({
  contract: ADDR,
  network: 'GenLayer Studionet',
  source: SOURCE,
  measured_at: new Date().toISOString(),
  runs_per_shape: RUNS,
  method: 'Same URL, same storage write, same return shape in all three. Only the '
    + 'contents of the round differ. A run counts as landed when the state change '
    + 'survived, read from the receipt rather than from the status word.',
  summary,
  attempts,
}, null, 2));

console.log('\n' + JSON.stringify(summary, null, 2));
console.log('\nwrote ' + OUT);
