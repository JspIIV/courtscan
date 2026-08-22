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
// Three states, and the middle one is where an earlier version of this went
// wrong. Treating "not JSON" as a decode failure excluded every round on the
// network at once, because most contracts do not return JSON and were never
// meant to. A rate computed that way is not stricter, it is empty.
//
//   NONE        no equivalence output. A deterministic round never had a model
//               answer to decode. The node writes the literal word "padded"
//               into an eight byte placeholder for these, which is what that
//               string is when it turns up in a receipt.
//   READABLE    the output decodes: as a tagged value, or as a JSON object.
//   UNREADABLE  there is a real output and neither reading works. This is the
//               parse failure that must not count as agreement, because nobody
//               can say what was agreed on.
export function readability(tx) {
  const bytes = bytesOf(tx && tx.eqBlocksOutputs);
  if (!bytes || bytes.length < 6) return READ.NONE;

  let text = '';
  try {
    text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  } catch {
    text = '';
  }
  // The placeholder, not an answer.
  if (bytes.length <= 12 && text.includes('padded')) return READ.NONE;

  if (leaderSaid(tx)) return READ.READABLE;

  // Not JSON, which is ordinary. Decodable as a tagged value is still readable.
  for (let start = 0; start < Math.min(bytes.length, 10); start += 1) {
    const parsed = readValue(bytes, start);
    if (parsed && parsed.value !== null && parsed.value !== undefined) return READ.READABLE;
  }
  return READ.UNREADABLE;
}

// The calldata, decoded properly.
//
// GenLayer packs the call as a small tagged structure and I could find no
// published schema, so this was worked out from real transactions and is
// checked against captured ones in tests/fixtures.
//
// Each value begins with a LEB128 varint. Its low three bits are the type and
// the rest is a length or a count:
//
//   type 4  string, length bytes follow
//   type 5  array, that many values follow
//   type 6  map, that many key and value pairs follow
//
// Map keys are different: a single byte holding the key length, then the key.
// That asymmetry is why an earlier heuristic version read the method name
// correctly and returned no arguments at all: it applied the value rule to
// everything and the argument list quietly came back empty.

function varint(bytes, at) {
  let value = 0;
  let shift = 0;
  let i = at;
  while (i < bytes.length) {
    const byte = bytes[i];
    value |= (byte & 0x7f) << shift;
    i += 1;
    if ((byte & 0x80) === 0) return { value, next: i };
    shift += 7;
    if (shift > 28) return null;
  }
  return null;
}

function readValue(bytes, at) {
  const tag = varint(bytes, at);
  if (!tag) return null;
  const type = tag.value & 7;
  const size = tag.value >> 3;
  let i = tag.next;

  if (type === 4) {
    if (i + size > bytes.length) return null;
    let text = '';
    for (let k = 0; k < size; k += 1) text += String.fromCharCode(bytes[i + k]);
    return { value: text, next: i + size };
  }
  if (type === 5) {
    const items = [];
    for (let k = 0; k < size; k += 1) {
      const item = readValue(bytes, i);
      if (!item) return null;
      items.push(item.value);
      i = item.next;
    }
    return { value: items, next: i };
  }
  if (type === 6) {
    const out = {};
    for (let k = 0; k < size; k += 1) {
      const keyLength = bytes[i];
      if (keyLength === undefined || i + 1 + keyLength > bytes.length) return null;
      let key = '';
      for (let c = 0; c < keyLength; c += 1) key += String.fromCharCode(bytes[i + 1 + c]);
      i += 1 + keyLength;
      const item = readValue(bytes, i);
      if (!item) return null;
      out[key] = item.value;
      i = item.next;
    }
    return { value: out, next: i };
  }
  // Anything else is a shape this decoder has never seen. Say so rather than
  // guessing: a wrong guess here becomes a wrong claim on the page.
  return null;
}

// The call that opened the round: its method and its arguments.
export function readCall(hex) {
  const bytes = bytesOf(hex);
  if (!bytes || bytes.length < 4) return null;

  // The structure does not always start at byte 0; there is a short envelope in
  // front of it on some transactions. Find the first offset that parses into a
  // map carrying a method.
  for (let start = 0; start < Math.min(bytes.length, 8); start += 1) {
    const parsed = readValue(bytes, start);
    if (!parsed || typeof parsed.value !== 'object' || Array.isArray(parsed.value)) continue;
    const method = parsed.value.method;
    if (typeof method !== 'string' || !method) continue;
    const args = Array.isArray(parsed.value.args) ? parsed.value.args : [];
    return { method, args: args.map((a) => (typeof a === 'string' ? a : String(a))) };
  }
  return null;
}

// What a probe actually asked for, taken from its own calldata.
//
// A report says "this failed at 3500 characters with one bound field". Nothing
// stopped it saying that about a probe that carried twelve thousand. Binding the
// report to the call it cites is what makes the reported dimensions checkable
// rather than merely stated, and Assay's probe signature is
// probe(source_url, evidence_chars, bound_fields, mode).
export function probeDimensions(tx) {
  const call = readCall((tx && (tx.txCalldata || tx.txData)) || null);
  if (!call || call.method !== 'probe' || call.args.length < 4) return null;
  const [source_url, evidence_chars, bound_fields, mode] = call.args;
  const chars = Number(evidence_chars);
  const bound = Number(bound_fields);
  if (!Number.isFinite(chars) || !Number.isFinite(bound)) return null;
  return { source_url, evidence_chars: chars, bound_fields: bound, mode: String(mode) };
}

// Whether a report's own numbers match the probe it cites.
//
// The frontier is drawn on payload size and bound field count, so a report that
// names the wrong ones is not slightly off, it is a measurement of something
// else entered on this chart. Returns the list of disagreements, empty when the
// report and the calldata say the same thing.
export function dimensionMismatches(report, dims) {
  if (!dims) return ['the calldata does not decode as a probe call'];
  const out = [];
  const chars = Number(report.evidence_chars);
  const bound = Number(report.bound_fields);
  const mode = String(report.mode || '').toUpperCase();
  if (chars !== dims.evidence_chars) {
    out.push(`evidence_chars reported ${chars}, calldata says ${dims.evidence_chars}`);
  }
  if (bound !== dims.bound_fields) {
    out.push(`bound_fields reported ${bound}, calldata says ${dims.bound_fields}`);
  }
  if (mode !== String(dims.mode).toUpperCase()) {
    out.push(`mode reported ${mode}, calldata says ${dims.mode}`);
  }
  return out;
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
