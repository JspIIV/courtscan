// The pieces both views need: reading the chain, classifying a round, and
// keeping every link on this page.
//
// Split out of the page itself because the case record grew into its own
// screen's worth of layout, and one file holding both the reading and the
// rendering had stopped being readable.
import { createClient } from 'genlayer-js';
import { testnetAsimov } from 'genlayer-js/chains';

export const RPC = 'https://rpc-asimov.genlayer.com';
export const CONSENSUS = '0x6CAFF6769d70824745AD895663409DC70aB5B28E';
export const ASSAY = '0xbaBf2796De591Dfe9289b60bE68f4426449676fA';
export const REPO = 'https://github.com/JspIIV/courtscan';

// The round that makes the case, offered so nobody has to go looking: it reads
// as FINALIZED elsewhere and decided nothing at all.
export const EXAMPLE = '0x938a593d62056696702c5db81a7f61c487a970ddfc4f1eece34e676062d21545';

export const client = createClient({ chain: testnetAsimov });

// The decoder lives in decode.js, alone, and is re-exported here so the views
// keep importing from one place. It was briefly duplicated across both files,
// which is the same mistake that put a retry rule in two places in a sibling
// contract: two copies of one rule drift, and the drift is invisible until
// something disagrees with itself.
export { classify, leaderSaid, readCall, readability, agreementRate, OUTCOME, READ }
  from './decode.js';


export const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
export const short = (s) => (s ? `${String(s).slice(0, 10)}…${String(s).slice(-6)}` : '');
export const el = (id) => document.getElementById(id);

export async function rpc(method, params) {
  const res = await fetch(RPC, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = await res.json();
  if (body.error) throw new Error(body.error.message);
  return body.result;
}

// The classification the whole project turns on. The node reports three
// separate things about a round and no one of them says whether it stands.

export const MEANING = {
  AGREED: 'The validators agreed. This decision stands.',
  TIMED_OUT: 'The leader answered and the validators did not finish in time. The answer was discarded, so nothing was decided.',
  NOT_VOTED: 'The round was accepted and never voted on.',
  ERRORED: 'The round ran and ended in an error.',
  IN_FLIGHT: 'Still settling.',
  OTHER: 'The node reported something this page does not recognise.',
};
export const TONE = {
  AGREED: 'good', TIMED_OUT: 'bad', ERRORED: 'bad',
  NOT_VOTED: 'warn', IN_FLIGHT: 'muted', OTHER: 'muted',
};

// What a vote means, in words. A validator voting TIMEOUT is saying "I never
// got an answer to compare", not "I disagree", and a reader should not have to
// already know that to read the table.
export const VOTE_MEANING = {
  AGREE: 'accepted the leader’s answer',
  DISAGREE: 'rejected the leader’s answer',
  TIMEOUT: 'did not answer in time',
  DETERMINISTIC_VIOLATION: 'found the leader’s work did not reproduce',
  IDLE: 'was assigned and never voted',
  NOT_VOTED: 'never voted',
};
export const VOTE_TONE = {
  AGREE: 'good', DISAGREE: 'bad', TIMEOUT: 'warn',
  DETERMINISTIC_VIOLATION: 'bad', IDLE: 'muted', NOT_VOTED: 'muted',
};


// The call that opened the round, read out of the calldata.
//
// GenLayer packs the method name and arguments into bytes with no schema I
// could find published, so this does not claim to decode the format.

// ------------------------------------------------------- the case content

// There is no way to ask a deployed address what methods it has: the schema
// endpoint reads the EVM code, which for an Intelligent Contract is a 300 byte
// proxy, and answers "absent_runner_comment". So this tries the getters the
// ecosystem actually uses. Every contract examined, across five projects, names
// them get_<noun> and takes the id as a string. That is a convention, not a
// guarantee, so when none answers this says so rather than pretending the case
// had no content.
const GETTERS = [
  'get_review', 'get_case', 'get_dispute', 'get_claim', 'get_entry',
  'get_application', 'get_round', 'get_attestation', 'get_decision',
  'get_report', 'get_request', 'get_mandate', 'get_list', 'get_feed',
];

// Transient failures are constant on this endpoint, and giving up on the first
// one would make a case look empty when it is merely slow.
export async function readView(address, fn, args) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const raw = await client.readContract({ address, functionName: fn, args });
      try { return JSON.parse(raw); } catch { return raw; }
    } catch (e) {
      if (!/fetch failed|timeout|socket|Rate limit|busy|-32603/i.test(String(e.message))) return null;
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
  return null;
}

export async function readCase(address, call) {
  const id = call && call.args && call.args.length ? String(call.args[0]) : null;
  if (id === null) return null;

  for (const getter of GETTERS) {
    const found = await readView(address, getter, [id]);
    if (found && typeof found === 'object' && !found.error) {
      // A record often names the thing it belongs to. Following that once turns
      // "review 1" into "review 1, against these terms", which is the part a
      // reader came for.
      let parent = null;
      let parentName = null;
      for (const [key, value] of Object.entries(found)) {
        if (!key.endsWith('_id') || key === `${getter.replace('get_', '')}_id`) continue;
        const noun = key.replace(/_id$/, '');
        const got = await readView(address, `get_${noun}`, [String(value)]);
        if (got && typeof got === 'object' && !got.error) { parent = got; parentName = noun; break; }
      }
      return { getter, record: found, parent, parentName };
    }
  }
  return null;
}

const LONG = new Set(['terms', 'purpose', 'criteria', 'summary', 'statement', 'holding',
  'reasoning', 'argument', 'note', 'admission_criteria', 'why', 'detail']);
const HIDE = new Set(['departed', 'revisits', 'closed']);

/// One record as labelled fields, with prose set as prose and a URL as a link.
export function renderFields(record) {
  return Object.entries(record).map(([key, value]) => {
    if (value === '' || value === null || HIDE.has(key)) return '';
    const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
    if (!text) return '';
    const isUrl = /^https?:\/\//.test(text);
    const isAddress = /^0x[0-9a-fA-F]{40}$/.test(text);
    const body = isUrl
      ? `<a href="${esc(text)}" target="_blank" rel="noreferrer">${esc(text)}</a>`
      : esc(isAddress ? short(text) : text);
    const cls = LONG.has(key) ? 'prose' : (isAddress ? 'mono' : '');
    return `<div class="field"><div class="k">${esc(key.replace(/_/g, ' '))}</div>
      <div class="v ${cls}">${body}</div></div>`;
  }).join('');
}

// ---------------------------------------------------------------- linking

// Everything clickable stays on this page. The official explorer answers
// "Transaction details unavailable" for plenty of these rounds and has no page
// for plenty of these contracts, and handing somebody a dead end for a record
// this page is already holding is not a link, it is a shrug.
export const handlers = { round: null, contract: null };

export function wireLinks() {
  for (const link of document.querySelectorAll('a[data-contract]')) {
    link.onclick = (e) => {
      e.preventDefault();
      el('q').value = link.dataset.contract;
      if (handlers.contract) handlers.contract(link.dataset.contract);
      el('q').scrollIntoView({ block: 'start', behavior: 'smooth' });
    };
  }
  for (const link of document.querySelectorAll('a[data-round]')) {
    link.onclick = (e) => {
      e.preventDefault();
      el('q').value = link.dataset.round;
      if (handlers.round) handlers.round(link.dataset.round);
      el('q').scrollIntoView({ block: 'start', behavior: 'smooth' });
    };
  }
}

// Every round this page has decoded, from the sample and from the live scan
// both, so a contract seen a moment ago always resolves to something.
export const seenRounds = [];
export const remember = (rows) => {
  for (const r of rows) if (!seenRounds.some((x) => x.id === r.id)) seenRounds.push(r);
};
