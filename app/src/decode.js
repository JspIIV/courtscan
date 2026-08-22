// The decoder, and the one judgement it is allowed to make.
//
// Split out of lib.js so it can be tested against raw receipts with no browser
// and no network, which is the point a steward raised: a decoder that is only
// exercised by looking at the page is a decoder nobody has actually checked.
//
// Every function here is pure. Feed it a receipt as the node returned it and it
// answers the same way every time.

export const OUTCOME = {
  AGREED: 'AGREED',
  TIMED_OUT: 'TIMED_OUT',
  NOT_VOTED: 'NOT_VOTED',
  ERRORED: 'ERRORED',
  IN_FLIGHT: 'IN_FLIGHT',
  OTHER: 'OTHER',
};

// How well the leader's answer could be read. Separate from the outcome on
// purpose: whether the validators agreed and whether anybody can read what they
// agreed on are two different facts, and conflating them is what let a
// malformed answer count as a clean agreement.
export const READ = {
  NONE: 'NONE',            // no equivalence output at all: a deterministic round
  READABLE: 'READABLE',    // a JSON object came out
  UNREADABLE: 'UNREADABLE',// there was an output and it did not decode
};

export function classify(tx) {
  const status = String(tx.statusName || '');
  const result = String(tx.resultName || '');
  const execution = String(tx.txExecutionResultName || '');
  if (result === 'TIMEOUT') return OUTCOME.TIMED_OUT;
  if (execution === 'NOT_VOTED') return OUTCOME.NOT_VOTED;
  if (execution === 'FINISHED_WITH_ERROR') return OUTCOME.ERRORED;
  if (result === 'AGREE' || execution === 'FINISHED_WITH_RETURN') return OUTCOME.AGREED;
  if (status === 'PENDING' || status === 'ACTIVATED' || status === '') return OUTCOME.IN_FLIGHT;
  return OUTCOME.OTHER;
}

// The bytes of an equivalence output, or null.
function bytesOf(hex) {
  const text = String(hex || '');
  if (text.length < 4) return null;
  const pairs = text.slice(2).match(/.{1,2}/g);
  if (!pairs) return null;
  const out = new Uint8Array(pairs.length);
  for (let i = 0; i < pairs.length; i += 1) {
    const value = parseInt(pairs[i], 16);
    if (Number.isNaN(value)) return null;
    out[i] = value;
  }
  return out;
}

// What the leader said, or the empty string.
//
// The outputs are padded and the padding decodes to plausible looking words, so
// a substring that merely looks like prose is not enough. Only a balanced JSON
// object of some substance is accepted. Printing padding under "what the leader
// said" would be putting words in its mouth, which is the exact failure this
// project exists to expose.
export function leaderSaid(tx) {
  const bytes = bytesOf(tx && tx.eqBlocksOutputs);
  if (!bytes || bytes.length < 6) return '';
  let text = '';
  try {
    text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  } catch {
    return '';
  }
  const open = text.indexOf('{');
  const close = text.lastIndexOf('}');
  if (open < 0 || close <= open) return '';
  const slice = text.slice(open, close + 1).replace(/[^ -~]+/g, ' ').trim();
  return slice.length < 12 ? '' : slice;
}

// Whether the leader's answer could be read, as its own fact.
//
// A round with no equivalence output is NONE rather than UNREADABLE: a
// deterministic write never had a model answer to decode, and counting it as a
// decode failure would make every ordinary transaction look broken.
export function readability(tx) {
  const bytes = bytesOf(tx && tx.eqBlocksOutputs);
  if (!bytes || bytes.length < 6) return READ.NONE;
  return leaderSaid(tx) ? READ.READABLE : READ.UNREADABLE;
}

// The call that opened the round, read out of the calldata.
//
// GenLayer packs the method name and arguments into bytes with no schema I could
// find published, so this does not claim to decode the format. It finds the key,
// reads the tag byte after it, and shifts that byte right by three to get the
// length of the value. Worked out from real rounds: 0x34 sits before a six
// character method name, 0x0c before a one character argument.
export function readCall(hex) {
  if (!hex || String(hex).length < 6) return null;
  const bytes = bytesOf(hex);
  if (!bytes) return null;

  const ascii = (from, len) => {
    let out = '';
    for (let i = from; i < from + len && i < bytes.length; i += 1) {
      const b = bytes[i];
      if (b < 0x20 || b > 0x7e) return null;
      out += String.fromCharCode(b);
    }
    return out.length === len ? out : null;
  };
  const find = (word) => {
    for (let i = 0; i + word.length <= bytes.length; i += 1) {
      if (ascii(i, word.length) === word) return i;
    }
    return -1;
  };
  const valueAfter = (word) => {
    const at = find(word);
    if (at < 0) return null;
    const tag = bytes[at + word.length];
    if (tag === undefined) return null;
    const length = tag >> 3;
    if (length <= 0 || length > 64) return null;
    return ascii(at + word.length + 1, length);
  };

  const method = valueAfter('method');
  if (!method) return null;

  // Arguments follow the same shape, one after another, after the args key.
  const args = [];
  const argsAt = find('args');
  if (argsAt >= 0) {
    let cursor = argsAt + 4;
    // One byte announces the sequence itself before the first value.
    cursor += 1;
    for (let guard = 0; guard < 16; guard += 1) {
      const tag = bytes[cursor];
      if (tag === undefined) break;
      const length = tag >> 3;
      if (length <= 0 || length > 64) break;
      const value = ascii(cursor + 1, length);
      if (value === null) break;
      args.push(value);
      cursor += 1 + length;
    }
  }
  return { method, args };
}

// The agreement rate, and the rule about what may go into it.
//
// A steward's objection, and it was right: a round whose answer could not be
// decoded was being counted as an agreement. The validators may well have
// agreed, but a rate published as "how often the network agrees on an answer"
// cannot include rounds where nobody can say what the answer was. Those are
// counted, reported, and kept out of the numerator and the denominator alike.
//
// Rounds still in flight are excluded too, for the older and more obvious
// reason that they have not finished.
export function agreementRate(rounds) {
  const settled = [];
  let inFlight = 0;
  let undecodable = 0;

  for (const round of rounds) {
    const outcome = round.outcome || OUTCOME.OTHER;
    if (outcome === OUTCOME.IN_FLIGHT) { inFlight += 1; continue; }
    if (round.readability === READ.UNREADABLE) { undecodable += 1; continue; }
    settled.push(round);
  }

  const agreed = settled.filter((r) => r.outcome === OUTCOME.AGREED).length;
  return {
    rate: settled.length ? agreed / settled.length : null,
    agreed,
    counted: settled.length,
    in_flight: inFlight,
    undecodable,
    basis: ('rounds that had settled when this was taken, excluding rounds whose leader '
      + 'output could not be decoded: the validators may have agreed, but a rate about '
      + 'agreement on an answer cannot include rounds where nobody can say what the answer was'),
  };
}
