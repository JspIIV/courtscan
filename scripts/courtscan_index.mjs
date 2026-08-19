// Courtscan's indexer: every consensus round on GenLayer, decoded.
//
// The official explorer shows transactions. What it does not show is the thing
// that actually matters about a round: whether the validators agreed, or whether
// the leader answered perfectly well and the round was thrown away anyway. Those
// two look identical from the outside and mean opposite things. One is a verdict.
// The other is a verdict that never happened.
//
// This was not a guess. On 2026-08-19 a round on this network produced a WARN
// from its leader, finalised as TIMEOUT, and discarded it. Reading the explorer
// you would see a finalised transaction and conclude a decision had been made.
//
// ## How rounds are found
//
// Every GenLayer transaction passes through the consensus contract, which emits
// events as a round moves. The ABI for those events is not published anywhere I
// could find, so this does not pretend to decode them by name. It does something
// cruder and more honest: it takes every 32 byte value out of every topic,
// tries it as a round id, and keeps the ones the node recognises. Whatever a
// given event means, a round id inside it is still a round id.
//
// A byproduct worth having: which event signatures actually carry round ids,
// discovered by trying rather than by documentation. That map is written out
// with the sample.
import { createClient } from 'genlayer-js';
import { testnetAsimov } from 'genlayer-js/chains';
import fs from 'fs';

const RPC = process.env.GEN_RPC || 'https://rpc-asimov.genlayer.com';
const CONSENSUS = process.env.CONSENSUS || '0x6CAFF6769d70824745AD895663409DC70aB5B28E';
const BLOCKS = Number(process.env.BLOCKS || 400);      // how far back to look
const MAX_ROUNDS = Number(process.env.MAX_ROUNDS || 120); // how many to decode
const OUT = process.env.OUT || 'app/public/sample.json';

const client = createClient({ chain: testnetAsimov });
const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));

async function rpc(method, params) {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = await res.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

/// A round, reduced to what a reader actually needs.
///
/// `outcome` is the whole point. The node reports three separate things about a
/// round and none of them alone tells you whether a decision stands: a status,
/// a result, and an execution result. A round can be FINALIZED and still have
/// been thrown away.
function classify(tx) {
  const status = String(tx.statusName || '');
  const result = String(tx.resultName || '');
  const execution = String(tx.txExecutionResultName || '');

  if (result === 'TIMEOUT') return 'TIMED_OUT';
  if (execution === 'NOT_VOTED') return 'NOT_VOTED';
  if (execution === 'FINISHED_WITH_ERROR') return 'ERRORED';
  if (result === 'AGREE' || execution === 'FINISHED_WITH_RETURN') return 'AGREED';
  if (status === 'PENDING' || status === 'ACTIVATED' || status === '') return 'IN_FLIGHT';
  return 'OTHER';
}

/// What the leader actually said, when it can be read.
///
/// The equivalence block outputs are raw bytes with the leader's own answer
/// inside. It is worth surfacing precisely because a round can carry a perfectly
/// sensible answer and still not stand: seeing both at once is the thing no
/// other tool shows.
function leaderSaid(tx) {
  const hex = String(tx.eqBlocksOutputs || '');
  if (hex.length < 12) return '';
  let text = '';
  try { text = Buffer.from(hex.slice(2), 'hex').toString('utf8'); } catch { return ''; }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return '';   // there is no object in there to read
  const slice = text.slice(start, end + 1).replace(/[^ -~]+/g, ' ').trim();
  // The outputs carry padding that decodes to plausible looking words. Recording
  // one as the leader's answer would be putting words in its mouth.
  return slice.length < 12 ? '' : slice.slice(0, 400);
}

const head = Number(await rpc('eth_blockNumber', []));
const from = head - BLOCKS;
console.log(`consensus ${CONSENSUS}`);
console.log(`blocks    ${from} to ${head}\n`);

// ---- find candidate round ids ---------------------------------------------

// Scanned in windows, and the windows shrink when they have to.
//
// The node caps a query at 10,000 results and answers "Internal error" rather
// than saying so once the range is wide enough, which is how a 4,000 block scan
// failed outright the first time this ran. So a window that will not come back
// is halved and tried again, down to a single block, which is the smallest
// thing that can be asked for and therefore the honest floor.
async function logsBetween(lo, hi) {
  const out = [];
  let width = Math.max(1, Math.min(300, hi - lo));
  let cursor = lo;
  while (cursor <= hi) {
    const top = Math.min(cursor + width - 1, hi);
    try {
      const batch = await rpc('eth_getLogs', [{
        fromBlock: '0x' + cursor.toString(16),
        toBlock: '0x' + top.toString(16),
        address: CONSENSUS,
      }]);
      out.push(...batch);
      cursor = top + 1;
      continue;
    } catch (e) {
      if (width <= 1) {
        console.log(`  ..  block ${cursor} would not answer, skipping it`);
        cursor += 1;
        continue;
      }
      width = Math.max(1, Math.floor(width / 2));
      console.log(`  ..  narrowing the window to ${width} blocks`);
    }
  }
  return out;
}

const logs = await logsBetween(from, head);
console.log(`${logs.length} consensus events`);

const seen = new Map();          // candidate id -> the event signature it came from
for (const log of logs) {
  const topics = log.topics || [];
  for (let i = 1; i < topics.length; i++) {
    const value = String(topics[i]);
    if (value.length === 66 && !seen.has(value)) seen.set(value, String(topics[0]));
  }
}
console.log(`${seen.size} candidate round ids\n`);

// ---- decode them -----------------------------------------------------------

const rounds = [];
const bySignature = {};
let tried = 0;

for (const [id, signature] of seen) {
  if (rounds.length >= MAX_ROUNDS) break;
  tried += 1;
  let tx;
  try {
    const raw = await client.getTransaction({ hash: id });
    tx = JSON.parse(JSON.stringify(raw, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
  } catch { continue; }
  // A topic that is not a round id comes back as an empty record rather than an
  // error, so an empty recipient is how a false candidate is recognised.
  if (!tx || !tx.recipient || tx.recipient === '0x' + '0'.repeat(40)) continue;

  bySignature[signature] = (bySignature[signature] || 0) + 1;
  rounds.push({
    id,
    contract: String(tx.recipient),
    sender: String(tx.sender || ''),
    outcome: classify(tx),
    status: String(tx.statusName || ''),
    result: String(tx.resultName || ''),
    execution: String(tx.txExecutionResultName || ''),
    validators: Number(tx.numOfInitialValidators || 0),
    rotations: Number(tx.numOfRounds || 0),
    leader_said: leaderSaid(tx),
    at: Number(tx.createdTimestamp || 0),
  });
  if (rounds.length % 10 === 0) {
    console.log(`  ${rounds.length} rounds decoded (${tried} candidates tried)`);
    await sleep(0.2);
  }
}

// ---- what the sample says --------------------------------------------------

const tally = {};
for (const r of rounds) tally[r.outcome] = (tally[r.outcome] || 0) + 1;

const settled = rounds.filter((r) => r.outcome !== 'IN_FLIGHT');
const agreed = tally.AGREED || 0;
const agreementRate = settled.length ? (agreed / settled.length) : null;

const contracts = {};
for (const r of rounds) {
  const row = contracts[r.contract] || (contracts[r.contract] = { rounds: 0, agreed: 0 });
  row.rounds += 1;
  if (r.outcome === 'AGREED') row.agreed += 1;
}

console.log('\n--- the sample ---');
for (const [outcome, n] of Object.entries(tally).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${outcome.padEnd(11)} ${String(n).padStart(4)}`);
}
if (agreementRate !== null) {
  console.log(`\n  agreement rate ${(agreementRate * 100).toFixed(1)}% of ${settled.length} settled rounds`);
}
console.log(`  ${Object.keys(contracts).length} distinct contracts`);
console.log('\n  event signatures that carried round ids:');
for (const [sig, n] of Object.entries(bySignature).sort((a, b) => b[1] - a[1])) {
  console.log(`    ${sig} ${n}`);
}

const snapshot = {
  network: 'GenLayer Asimov',
  chain_id: 4221,
  consensus_contract: CONSENSUS,
  taken_at: new Date().toISOString(),
  head_block: head,
  from_block: from,
  blocks_scanned: BLOCKS,
  events_seen: logs.length,
  candidates: seen.size,
  rounds_decoded: rounds.length,
  capped_at: MAX_ROUNDS,
  tally,
  settled_rounds: settled.length,
  agreement_rate: agreementRate,
  distinct_contracts: Object.keys(contracts).length,
  contracts,
  event_signatures_carrying_round_ids: bySignature,
  caution: (
    'a sample of one window of blocks, not the whole chain. The agreement rate is '
    + 'over rounds that had settled when this was taken; rounds still in flight are '
    + 'counted separately and excluded from it'),
  rounds,
};

fs.mkdirSync(OUT.split('/').slice(0, -1).join('/'), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(snapshot, null, 2));
console.log(`\nwritten to ${OUT}`);
