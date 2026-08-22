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
  OUTCOME, READ, agreementRate, classify, dimensionMismatches, leaderSaid, probeDimensions,
  readCall, readability,
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

test('readability and leaderSaid stay consistent on every fixture', () => {
  // They are not the same question and must not be conflated. leaderSaid is
  // "is there a JSON object worth showing"; readability is "can the output be
  // decoded at all". Plenty of contracts return a tagged value that is perfectly
  // readable and is not JSON, and calling those undecodable once excluded every
  // round on the network at once.
  //
  // What must hold in both directions: anything worth showing is readable, and
  // nothing undecodable has anything to show.
  for (const tx of all()) {
    const said = leaderSaid(tx);
    const read = readability(tx);
    if (said !== '') assert.equal(read, READ.READABLE, 'something to show must be readable');
    if (read === READ.UNREADABLE) assert.equal(said, '', 'undecodable must show nothing');
  }
});

test('the padding placeholder is not an answer and not a failure', () => {
  // The node writes an eight byte placeholder containing the word "padded" for
  // rounds that had no equivalence block. Reading that as a decode failure is
  // what emptied the rate: every deterministic round on the network carries one.
  const tx = load('a21f5097.json');
  assert.equal(readability(tx), READ.NONE);
  assert.equal(leaderSaid(tx), '');
});

test('a real tagged output is readable even though it is not JSON', () => {
  const tx = load('090749e0.json');
  assert.equal(readability(tx), READ.READABLE);
});

test('a real JSON answer is readable and is shown', () => {
  const tx = load('938a593d.json');
  assert.equal(readability(tx), READ.READABLE);
  assert.ok(leaderSaid(tx).startsWith('{'));
});

// -------------------------------------------------------------- the calldata

test('a real call decodes to its method and arguments', () => {
  // Captured from a live examine(1, 3) sent to Concordance through a wallet.
  const hex = '0x' + 'dc9a160461726773150c310c33066d6574686f643c6578616d696e6500000000';
  const call = readCall(hex);
  assert.deepEqual(call, { method: 'examine', args: ['1', '3'] });
});

// A real probe call, from the transaction one of Assay's failure reports cites.
// The two byte length on the URL is the case that matters: a single byte tag
// cannot express seventy three characters, and an earlier decoder returned an
// empty argument list here while still reporting the method correctly, which is
// the quietest way for a decoder to be wrong.
test('a probe call decodes to all four of its arguments', () => {
  const tx = load('1221260f.json');
  const call = readCall(tx.txCalldata || tx.txData);
  assert.equal(call.method, 'probe');
  assert.equal(call.args.length, 4);
  assert.ok(call.args[0].startsWith('https://'),
    'a multi byte length must be read as one number');
  assert.ok(call.args[0].length > 60);
});

test('probe dimensions come out of the calldata as numbers', () => {
  const tx = load('1221260f.json');
  const dims = probeDimensions(tx);
  assert.equal(typeof dims.evidence_chars, 'number');
  assert.equal(typeof dims.bound_fields, 'number');
  assert.ok(dims.evidence_chars > 0);
  assert.equal(dims.mode, 'STRICT');
});

test('a report whose numbers match its probe passes the binding', () => {
  const dims = probeDimensions(load('1221260f.json'));
  assert.deepEqual(dimensionMismatches(dims, dims), []);
});

test('a report that overstates or understates its probe is caught', () => {
  // This is the binding doing its job. Each altered field must be reported, and
  // a payload size is the one that matters most: it is the axis the frontier is
  // drawn on, so a wrong one moves the published edge.
  const dims = probeDimensions(load('1221260f.json'));

  const smaller = dimensionMismatches({ ...dims, evidence_chars: 500 }, dims);
  assert.equal(smaller.length, 1);
  assert.match(smaller[0], /evidence_chars reported 500/);

  const bigger = dimensionMismatches({ ...dims, evidence_chars: 12000 }, dims);
  assert.equal(bigger.length, 1);

  const bound = dimensionMismatches({ ...dims, bound_fields: 99 }, dims);
  assert.equal(bound.length, 1);
  assert.match(bound[0], /bound_fields/);

  const mode = dimensionMismatches({ ...dims, mode: 'LOOSE' }, dims);
  assert.equal(mode.length, 1);
  assert.match(mode[0], /mode/);

  const everything = dimensionMismatches(
    { evidence_chars: 1, bound_fields: 2, mode: 'X' }, dims);
  assert.equal(everything.length, 3, 'every wrong field must be named, not just the first');
});

test('a report bound to a call that is not a probe fails the binding', () => {
  assert.deepEqual(dimensionMismatches({ evidence_chars: 1, bound_fields: 1, mode: 'STRICT' }, null),
    ['the calldata does not decode as a probe call']);
});

test('a call that is not a probe yields no dimensions', () => {
  // The binding must refuse to describe something it did not read, or a report
  // could be bound to a transaction that never carried those dimensions at all.
  const notAProbe = '0x' + 'dc9a160461726773150c310c33066d6574686f643c6578616d696e6500000000';
  assert.equal(probeDimensions({ txData: notAProbe }), null);
  assert.equal(probeDimensions({ txData: '0xdeadbeef' }), null);
  assert.equal(probeDimensions({}), null);
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
