// Prove the measured runs kept their state, rather than only returning a
// result from the leader.
//
//   node scripts/verify_round_shapes.mjs [contract]
//
// The distinction matters and the first version of this measurement blurred it.
// A leader receipt tells you what the leader computed. It does not tell you
// that the round was accepted, or that the write it describes is still there.
// A round can return a clean payload and be discarded, and the payload will
// look exactly the same either way.
//
// So this asks the contract instead, with plain reads that need no account.
// Every run recorded in results/round_shapes.json carries the storage index
// the contract assigned when it appended the record. That index is read back
// here, from the chain, now. A record that comes back matching the shape it
// was written for is a state change that survived; a missing or mismatched one
// is a run that did not.
import { createClient } from 'genlayer-js';
import { studionet } from 'genlayer-js/chains';
import fs from 'fs';

const FILE = 'results/round_shapes.json';
const measured = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const ADDR = process.argv[2] || measured.contract;
const client = createClient({ chain: studionet });

const wait = ms => new Promise(r => setTimeout(r, ms));

/** Studionet rations requests. A verification that trips the limit and gives
 *  up looks exactly like a verification that failed, so this waits it out. */
async function read(fn, args = []) {
  for (let attempt = 1; ; attempt++) {
    try { return await client.readContract({ address: ADDR, functionName: fn, args }); }
    catch (e) {
      const why = String(e?.details || e?.message || e);
      if (attempt >= 4 || !/rate limit/i.test(why)) throw e;
      console.log(`  (rate limited, waiting 65s)`);
      await wait(65000);
    }
  }
}

console.log('Reading GenLayer Studionet. No account, nothing spent.\n');
console.log('  contract ' + ADDR);
console.log('  measured ' + measured.attempts.length + ' runs on ' + measured.measured_at + '\n');

const size = JSON.parse(await read('size'));
console.log('The contract itself reports ' + size.landed + ' records in storage: '
  + Object.entries(size.by_shape).map(([k, v]) => `${v} ${k}`).join(', ') + '.\n');

let checked = 0;
let survived = 0;
const missing = [];

for (const attempt of measured.attempts) {
  let index = null;
  try { index = JSON.parse(attempt.returned)?.index; } catch { index = null; }
  if (index === null || index === undefined) {
    missing.push({ ...attempt, why: 'the run recorded no storage index' });
    continue;
  }
  checked += 1;
  const raw = await read('run_at', [String(index)]);
  let record = null;
  try { record = JSON.parse(raw); } catch { record = null; }

  if (record && record.shape === attempt.shape) {
    survived += 1;
  } else {
    missing.push({ ...attempt, index, got: raw, why: 'no matching record at that index' });
  }
}

console.log(`Read back ${checked} of the measured runs by the storage index each one`);
console.log(`reported writing to. ${survived} came back with a record of the right shape.\n`);

if (missing.length) {
  console.log('These did not:');
  for (const m of missing) console.log('  ' + m.shape + ' run ' + m.run + ': ' + m.why);
} else {
  console.log('Every measured run is still in the contract\'s storage, readable by');
  console.log('anybody, with no account and no cooperation from us. The state changes');
  console.log('were kept; they were not just returned by a leader.');
}

fs.writeFileSync('results/round_shapes_verified.json', JSON.stringify({
  contract: ADDR,
  verified_at: new Date().toISOString(),
  method: 'each measured run read back from chain by the storage index it reported writing to',
  contract_reports: size,
  checked, survived, missing,
}, null, 2));
console.log('\nWritten to results/round_shapes_verified.json');
