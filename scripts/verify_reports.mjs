// Check every failure report in Assay against the chain, and take the chain's
// word rather than the reporter's.
//
// A steward's objection, and it was right. Assay's `report_failure` takes a
// transaction hash and a claimed outcome, and the contract cannot check either:
// an Intelligent Contract cannot read a receipt from inside itself. So anybody
// could report a failure that never happened, at any payload size, and move the
// published frontier below payloads that demonstrably agree. The frontier would
// then be a claim about who reported, not about the network.
//
// The contract cannot verify. A reader can.
//
// This does two things, and the second matters more than the first. It rejects
// reports whose transaction does not exist or was not a probe. And for the ones
// that survive, it **derives the outcome from the receipt** instead of believing
// the label, because the interesting error is not a fabricated report, it is an
// honest one filed under the wrong heading.
//
// That is not hypothetical. The first run of this script found one of our own
// reports labelled REVERTED whose receipt says NO_MAJORITY: the validators could
// not reach a majority, which is agreement actually breaking, filed in a bucket
// the frontier sets aside. The published claim that nothing had broken yet was
// wrong because of it.
//
// Run: node scripts/verify_reports.mjs

import { createClient } from 'genlayer-js';
import { testnetAsimov } from 'genlayer-js/chains';
import fs from 'node:fs';

const ASSAY = '0xbaBf2796De591Dfe9289b60bE68f4426449676fA';
const OUT = 'app/public/verified_reports.json';

const client = createClient({ chain: testnetAsimov });

// What the receipt actually says happened, in Assay's vocabulary.
export function outcomeFromReceipt(tx) {
  const result = String(tx.resultName || '');
  const execution = String(tx.txExecutionResultName || '');
  const votes = (tx.consensusData && tx.consensusData.validatorVotesName) || [];

  if (result === 'TIMEOUT') return 'TIMEOUT';
  if (result === 'NO_MAJORITY') return 'NO_MAJORITY';
  if (execution === 'NOT_VOTED') return 'NOT_VOTED';
  if (execution === 'FINISHED_WITH_ERROR') return 'FINISHED_WITH_ERROR';
  if (votes.includes('DISAGREE')) return 'DISAGREEMENT';
  if (result === 'AGREE' || execution === 'FINISHED_WITH_RETURN') return 'AGREED';
  return 'UNCLASSIFIED';
}

// Which of those say something about *agreement*, and which are about something
// else. This is the whole judgement in the file, so it is written down rather
// than buried in a filter.
//
//   NO_MAJORITY  the validators could not reach a majority. Agreement failed.
//   DISAGREEMENT at least one validator rejected the leader's answer.
//
// Everything else is set aside, and each for its own reason:
//
//   TIMEOUT              validators did not finish in time. A fact about speed
//                        and load, not about whether they could have agreed.
//   NOT_VOTED            the round was never voted on. A fact about the queue.
//   FINISHED_WITH_ERROR  the contract raised. A fact about the contract.
//
// Letting the last three move the frontier would put the edge below payload
// sizes that demonstrably agree, which is exactly the distortion complained of.
export const COUNTS_AGAINST_AGREEMENT = ['NO_MAJORITY', 'DISAGREEMENT'];

async function readContract(fn, args = []) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const raw = await client.readContract({ address: ASSAY, functionName: fn, args });
      return JSON.parse(raw);
    } catch (e) {
      if (attempt === 3) throw e;
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
  return null;
}

async function verify(report) {
  const hash = String(report.tx_hash || '');
  const reject = (reason) => ({ ...report, verified: false, reason });

  let tx;
  try {
    tx = await client.getTransaction({ hash });
  } catch (e) {
    return reject(`the cited transaction could not be read: ${String(e.message).slice(0, 90)}`);
  }
  if (!tx) return reject('no such transaction on this network');

  const recipient = String(tx.recipient || tx.to || '').toLowerCase();
  if (recipient && recipient !== ASSAY.toLowerCase()) {
    return reject(`that transaction went to ${recipient}, not to Assay, so it was not a probe`);
  }

  const actual = outcomeFromReceipt(tx);
  if (actual === 'AGREED') {
    return reject('the chain shows this round agreed, so it is not a failure at all');
  }
  if (actual === 'UNCLASSIFIED') {
    return reject('the receipt does not show a recognisable outcome');
  }

  const claimed = String(report.outcome || '').toUpperCase();
  return {
    ...report,
    verified: true,
    claimed_outcome: claimed,
    actual_outcome: actual,
    mislabelled: claimed !== actual,
    counts_against_agreement: COUNTS_AGAINST_AGREEMENT.includes(actual),
    on_chain: {
      status: tx.statusName || null,
      result: tx.resultName || null,
      execution: tx.txExecutionResultName || null,
      votes: (tx.consensusData && tx.consensusData.validatorVotesName) || null,
    },
  };
}

// The frontier, rebuilt from what the chain says rather than from what was
// claimed. Only verified reports whose real outcome bears on agreement may move
// smallest_failed.
function frontier(runs, checked) {
  const rows = new Map();
  const slot = (mode, bound) => {
    const key = `${mode}:${bound}`;
    if (!rows.has(key)) {
      rows.set(key, {
        mode, bound_fields: bound, largest_agreed: null, smallest_failed: null,
        agreed: 0, failed: 0, set_aside: 0,
      });
    }
    return rows.get(key);
  };

  for (const run of runs) {
    const row = slot(run.mode, Number(run.bound_fields));
    const size = Number(run.evidence_chars);
    row.agreed += 1;
    if (row.largest_agreed === null || size > row.largest_agreed) row.largest_agreed = size;
  }

  for (const report of checked) {
    if (!report.verified) continue;
    const row = slot(report.mode, Number(report.bound_fields));
    const size = Number(report.evidence_chars);
    if (report.counts_against_agreement) {
      row.failed += 1;
      if (row.smallest_failed === null || size < row.smallest_failed) row.smallest_failed = size;
    } else {
      row.set_aside += 1;
    }
  }

  return [...rows.values()].map((row) => ({
    ...row,
    observations: row.agreed + row.failed,
    settled: row.largest_agreed !== null && row.smallest_failed !== null
      && row.largest_agreed < row.smallest_failed,
  })).sort((a, b) => (a.mode + a.bound_fields).localeCompare(b.mode + b.bound_fields));
}

const reportsRaw = await readContract('get_reports');
const list = Array.isArray(reportsRaw) ? reportsRaw : (reportsRaw.reports || []);
const runsRaw = await readContract('get_runs');
const runs = Array.isArray(runsRaw) ? runsRaw : (runsRaw.runs || []);

console.log(`checking ${list.length} report(s) against the chain`);
const checked = [];
for (const report of list) {
  const result = await verify(report);
  checked.push(result);
  if (!result.verified) {
    console.log(`  reject  ${report.tx_hash.slice(0, 12)} ${report.outcome}: ${result.reason}`);
  } else if (result.mislabelled) {
    console.log(`  ok      ${report.tx_hash.slice(0, 12)} filed as ${result.claimed_outcome},`
      + ` chain says ${result.actual_outcome}`
      + (result.counts_against_agreement ? '  <- this one bears on agreement' : ''));
  } else {
    console.log(`  ok      ${report.tx_hash.slice(0, 12)} ${result.actual_outcome}`);
  }
}

const verified = checked.filter((r) => r.verified);
const breaks = verified.filter((r) => r.counts_against_agreement);

const out = {
  contract: ASSAY,
  checked_at: new Date().toISOString(),
  reports_seen: checked.length,
  verified: verified.length,
  rejected: checked.length - verified.length,
  mislabelled: verified.filter((r) => r.mislabelled).length,
  agreement_breaks: breaks.length,
  counts_against_agreement: COUNTS_AGAINST_AGREEMENT,
  method: ('Assay cannot read a receipt from inside itself, so every report is a claim until '
    + 'something checks it. Each one here was fetched from the chain, confirmed to have been sent '
    + 'to Assay, and its outcome taken from the receipt rather than from the label it was filed '
    + 'under. Only outcomes that bear on agreement move the frontier.'),
  frontier: frontier(runs, checked),
  reports: checked,
};

fs.mkdirSync(OUT.split('/').slice(0, -1).join('/'), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out, null, 2));

console.log(`\n  ${verified.length} verified, ${out.rejected} rejected, ${out.mislabelled} mislabelled`);
console.log(`  ${breaks.length} round(s) where agreement actually broke`);
for (const b of breaks) {
  console.log(`    ${b.actual_outcome} at ${b.evidence_chars} chars, `
    + `${b.bound_fields} bound field(s), ${b.mode}`);
}
console.log(`  -> ${OUT}`);
