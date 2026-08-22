// The decoder and the rate, checked against raw receipts and against invariants.
//
// Run: node --test tests/
//
// The fixtures in tests/fixtures are receipts exactly as the node returned them,
// captured with scripts/grab_fixtures.mjs. Nothing in here reaches the network,
// which is deliberate: these are the properties that must hold on the days the
// testnet is unwell, and a test that needs a healthy chain to run is a test that
// is skipped on exactly those days.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  OUTCOME, READ, agreementRate, classify, leaderSaid, readCall, readability,
} from '../app/src/decode.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, 'fixtures');

const load = (name) => JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8'));
const all = () => fs.readdirSync(FIXTURES).filter((f) => f.endsWith('.json')).map(load);

// ---------------------------------------------------------------- real rounds

test('a round the validators never voted on is NOT_VOTED, not agreement', () => {
  const tx = load('36bfa3a1.json');
  assert.equal(classify(tx), OUTCOME.NOT_VOTED);
  assert.notEqual(classify(tx), OUTCOME.AGREED);
});

test('a round with no equivalence output is not a decode failure', () => {
  // A deterministic write never had a model answer to decode. Calling that
  // UNREADABLE would make every ordinary transaction look broken.
  const tx = load('36bfa3a1.json');
  assert.equal(readability(tx), READ.NONE);
});

test('padding is never reported as something the leader said', () => {
  // The equivalence outputs are padded and the padding decodes to plausible
  // looking words. This is the failure the whole project exists to expose, so
  // it is the one asserted hardest: whatever comes back must either be a real
  // JSON object or nothing at all.
  for (const tx of all()) {
    const said = leaderSaid(tx);
    if (said === '') continue;
    assert.ok(said.startsWith('{') && said.endsWith('}'),
      `leaderSaid returned something that is not an object: ${said.slice(0, 60)}`);
    assert.ok(said.length >= 12);
  }
});

test('every fixture classifies into a known outcome', () => {
  const known = new Set(Object.values(OUTCOME));
  for (const tx of all()) assert.ok(known.has(classify(tx)));
});

test('readability agrees with leaderSaid on every fixture', () => {
  // The invariant that keeps the two from drifting apart: READABLE if and only
  // if there is something to show.
  for (const tx of all()) {
    const said = leaderSaid(tx);
    const read = readability(tx);
    if (read === READ.READABLE) assert.notEqual(said, '');
    if (read === READ.UNREADABLE) assert.equal(said, '');
  }
});

// -------------------------------------------------------------- the calldata

test('a real call decodes to its method and arguments', () => {
  // Captured from a live examine(1, 3) sent to Concordance through a wallet.
  const hex = '0x' + 'dc9a160461726773150c310c33066d6574686f643c6578616d696e6500000000';
  const call = readCall(hex);
  assert.deepEqual(call, { method: 'examine', args: ['1', '3'] });
});

test('calldata that decodes to nothing returns null rather than guessing', () => {
  for (const bad of ['', '0x', '0xff', '0x0000000000000000', null, undefined]) {
    assert.equal(readCall(bad), null);
  }
});

test('a decoded method never contains unprintable bytes', () => {
  for (const tx of all()) {
    const call = readCall(tx.txCalldata || tx.txData);
    if (!call) continue;
    assert.match(call.method, /^[ -~]+$/);
    for (const arg of call.args) assert.match(arg, /^[ -~]*$/);
  }
});

// ------------------------------------------------------------------ the rate

const round = (outcome, read = READ.NONE) => ({ outcome, readability: read });

test('the rate is agreed over settled rounds', () => {
  const out = agreementRate([
    round(OUTCOME.AGREED), round(OUTCOME.AGREED),
    round(OUTCOME.AGREED), round(OUTCOME.NOT_VOTED),
  ]);
  assert.equal(out.agreed, 3);
  assert.equal(out.counted, 4);
  assert.equal(out.rate, 0.75);
});

test('rounds in flight are excluded from the rate entirely', () => {
  const out = agreementRate([
    round(OUTCOME.AGREED), round(OUTCOME.IN_FLIGHT), round(OUTCOME.IN_FLIGHT),
  ]);
  assert.equal(out.rate, 1);
  assert.equal(out.counted, 1);
  assert.equal(out.in_flight, 2);
});

test('an undecodable round never counts as agreement', () => {
  // The steward's objection, as a test. The validators may have agreed, but a
  // rate about agreement on an answer cannot include a round where nobody can
  // say what the answer was.
  const out = agreementRate([
    round(OUTCOME.AGREED), round(OUTCOME.AGREED, READ.UNREADABLE),
  ]);
  assert.equal(out.agreed, 1);
  assert.equal(out.counted, 1);
  assert.equal(out.undecodable, 1);
  assert.equal(out.rate, 1);
});

test('undecodable rounds cannot inflate the rate in either direction', () => {
  // Adding an undecodable round must leave the published rate untouched,
  // whatever its outcome claims to be.
  const base = [round(OUTCOME.AGREED), round(OUTCOME.AGREED), round(OUTCOME.NOT_VOTED)];
  const before = agreementRate(base).rate;
  for (const outcome of Object.values(OUTCOME)) {
    const after = agreementRate([...base, round(outcome, READ.UNREADABLE)]).rate;
    assert.equal(after, before, `an undecodable ${outcome} round moved the rate`);
  }
});

test('the rate is null rather than zero when nothing can be counted', () => {
  // Zero would read as "the network never agrees", which is a claim. Null is
  // the absence of one.
  assert.equal(agreementRate([]).rate, null);
  assert.equal(agreementRate([round(OUTCOME.IN_FLIGHT)]).rate, null);
  assert.equal(agreementRate([round(OUTCOME.AGREED, READ.UNREADABLE)]).rate, null);
});

test('the rate always lies between 0 and 1, on every mix of inputs', () => {
  const outcomes = Object.values(OUTCOME);
  const reads = Object.values(READ);
  for (let i = 0; i < outcomes.length; i += 1) {
    for (let j = 0; j < reads.length; j += 1) {
      for (let k = 0; k < outcomes.length; k += 1) {
        const out = agreementRate([round(outcomes[i], reads[j]), round(outcomes[k])]);
        if (out.rate === null) continue;
        assert.ok(out.rate >= 0 && out.rate <= 1, `rate out of range: ${out.rate}`);
        assert.ok(out.agreed <= out.counted);
      }
    }
  }
});

test('every round lands in exactly one bucket', () => {
  // Nothing may be counted twice and nothing may be dropped silently, which is
  // how a published total quietly stops adding up.
  const sample = [
    round(OUTCOME.AGREED), round(OUTCOME.NOT_VOTED), round(OUTCOME.IN_FLIGHT),
    round(OUTCOME.TIMED_OUT), round(OUTCOME.AGREED, READ.UNREADABLE),
    round(OUTCOME.ERRORED, READ.READABLE),
  ];
  const out = agreementRate(sample);
  assert.equal(out.counted + out.in_flight + out.undecodable, sample.length);
});
