// The case record, laid out as a record rather than as a wall of keys.
//
// A court record has parts and they deserve different shapes. The verdict leads
// at the size it deserves. The two things a reader actually compares, the claim
// and the rule it is judged against, sit side by side. The leader's answer is
// read as a finding rather than printed as JSON, with the raw text one click
// away, because a page about not trusting appearances should not hide its
// source.
import {
  esc, short, el, classify, MEANING, TONE, VOTE_MEANING, VOTE_TONE,
  leaderSaid, readCall, readCase, renderFields, wireLinks, client,
} from './lib.js';

// Which field of a leader's answer is the finding, and which are prose. Tried
// in order, because contracts name the same thing differently: a verdict, a
// tier, a decision.
const HEADLINE = ['decision', 'verdict', 'tier', 'outcome', 'status', 'result'];
const PROSE = ['holding', 'reasoning', 'reason', 'why', 'summary', 'explanation', 'note'];

export function parseProposal(said) {
  if (!said) return null;
  let parsed;
  try { parsed = JSON.parse(said); } catch { return null; }
  if (!parsed || typeof parsed !== 'object') return null;

  let headline = null;
  let headlineKey = null;
  for (const key of HEADLINE) {
    if (parsed[key] !== undefined && typeof parsed[key] !== 'object') {
      headline = String(parsed[key]);
      headlineKey = key;
      break;
    }
  }
  const prose = [];
  const chips = [];
  for (const [key, value] of Object.entries(parsed)) {
    if (key === headlineKey) continue;
    if (value === '' || value === null || typeof value === 'object') continue;
    const text = String(value);
    if (PROSE.includes(key) && text.length > 40) prose.push(text);
    else chips.push([key, text]);
  }
  return { headline, prose, chips };
}

const MARK = { AGREED: '✓', TIMED_OUT: '⏱', NOT_VOTED: '·', ERRORED: '!', IN_FLIGHT: '…' };

export async function showRound(id) {
  el('result').innerHTML = '<div class="verdict"><p class="loading">Reading that round…</p></div>';
  let tx;
  try {
    const raw = await client.getTransaction({ hash: id });
    tx = JSON.parse(JSON.stringify(raw, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
  } catch (e) {
    el('result').innerHTML = `<div class="verdict bad"><p class="bad">Could not read it: ${esc(e.message)}</p></div>`;
    return;
  }
  if (!tx || !tx.recipient) {
    el('result').innerHTML = '<div class="verdict"><p class="muted">The node has no round under that id.</p></div>';
    return;
  }

  const outcome = classify(tx);
  const tone = TONE[outcome];
  const said = leaderSaid(tx);
  const proposal = parseProposal(said);
  const call = readCall(tx.txCalldata || tx.txData);
  const round = tx.lastRound || {};
  const validators = round.roundValidators || [];
  const votes = round.validatorVotesName || [];
  const hashes = round.validatorResultHash || [];
  const leaderIndex = Number(round.leaderIndex ?? -1);
  const leader = validators[leaderIndex] || tx.lastLeader || '';

  // The chain does not label a winning answer, so this counts: the result hash
  // the most validators produced is the one the round was heading towards.
  const counts = {};
  for (const h of hashes) counts[h] = (counts[h] || 0) + 1;
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  const topHash = top ? top[0] : null;
  const together = top ? top[1] : 0;
  const apart = hashes.length - together;
  const share = hashes.length ? Math.round((together / hashes.length) * 100) : 0;

  const voteRows = validators.map((address, i) => {
    const vote = votes[i] || '';
    const same = hashes[i] && hashes[i] === topHash;
    return `
      <tr>
        <td>${i === leaderIndex
    ? '<span class="pill good">LEADER</span>'
    : '<span class="dim">validator</span>'}</td>
        <td class="said">${esc(short(address))}</td>
        <td><span class="pill ${VOTE_TONE[vote] || 'muted'}">${esc(vote || '—')}</span></td>
        <td class="muted">${esc(VOTE_MEANING[vote] || '')}</td>
        <td>${hashes[i]
    ? (same ? '<span class="good">same answer</span>' : '<span class="bad">different answer</span>')
    : '<span class="dim">—</span>'}</td>
      </tr>`;
  }).join('');

  el('result').innerHTML = `
    <div class="verdict ${tone}">
      <div class="verdict-head">
        <div class="mark ${tone}">${MARK[outcome] || '?'}</div>
        <div class="headline">
          <h2 class="outcome ${tone}">${esc(outcome.replace(/_/g, ' ').toLowerCase())}</h2>
          <p>${esc(MEANING[outcome])}</p>
        </div>
      </div>

      <h3 class="section">Who brought it</h3>
      <div class="facts">
        <div><span>brought by</span><b class="said">${esc(short(tx.sender || ''))}</b></div>
        <div><span>against</span><b><a href="#" data-contract="${esc(tx.recipient)}">${esc(short(tx.recipient))}</a></b></div>
        <div><span>asked for</span><b>${call && call.method
    ? esc(call.method) : '<span class="dim">unreadable</span>'}${call && call.args && call.args.length
    ? ` <span class="muted">(${call.args.map((a) => esc(a)).join(', ')})</span>` : ''}</b></div>
      </div>

      <div id="case-content"></div>

      <h3 class="section">What the leader proposed</h3>
      ${leader ? `<p class="hint" style="margin:0 0 12px">Leader <code>${esc(short(leader))}</code></p>` : ''}
      ${proposal ? `
        <div class="proposal">
          ${proposal.headline ? `<p class="decision ${tone}">${esc(proposal.headline)}</p>` : ''}
          ${proposal.prose.map((text, i) => `<p class="${i === 0 ? 'holding' : 'why'}">${esc(text)}</p>`).join('')}
          ${proposal.chips.length ? `<div class="chips">${proposal.chips
    .map(([k, v]) => `<span class="chip">${esc(k.replace(/_/g, ' '))} <b>${esc(v)}</b></span>`).join('')}</div>` : ''}
          <details class="raw"><summary>the answer as the chain stored it</summary>
            <pre><code>${esc(said)}</code></pre></details>
        </div>`
    : (said ? `<pre><code>${esc(said)}</code></pre>`
      : '<p class="hint">The equivalence outputs carry nothing readable for this round.</p>')}
      ${outcome === 'TIMED_OUT' && said
    ? '<p class="caution">This answer was thrown away. The round timed out, so nothing in it was decided.</p>' : ''}

      <h3 class="section">How the validators voted</h3>
      ${validators.length ? `
        <div class="split-bar">
          <i class="same" style="width:${share}%"></i><i class="apart" style="width:${100 - share}%"></i>
        </div>
        <div class="split-legend">
          <span><i class="sw same"></i><b>${together}</b> arrived at the same answer</span>
          <span><i class="sw apart"></i><b>${apart}</b> arrived at something else</span>
          <span><b>${esc(round.votesRevealed ?? '0')}</b> of ${esc(round.votesCommitted ?? '0')} revealed</span>
          <span><b>${esc(round.rotationsLeft ?? '—')}</b> rotations left</span>
        </div>
        <div class="scroll" style="margin-top:14px"><table>
          <thead><tr><th>Role</th><th>Validator</th><th>Vote</th><th>What that means</th><th>Answer</th></tr></thead>
          <tbody>${voteRows}</tbody>
        </table></div>`
    : '<p class="hint">The chain reports no per validator record for this round.</p>'}

      <h3 class="section">How it ended</h3>
      <div class="facts">
        <div><span>status</span><b>${esc(tx.statusName || '-')}</b></div>
        <div><span>result</span><b>${esc(tx.resultName || '-')}</b></div>
        <div><span>execution</span><b>${esc(tx.txExecutionResultName || '-')}</b></div>
        <div><span>rotations used</span><b>${esc(tx.numOfRounds ?? 0)} of ${esc(tx.initialRotations ?? 0)}</b></div>
        <div><span>settled in</span><b>${tx.lastVoteTimestamp && tx.createdTimestamp
    ? `${Number(tx.lastVoteTimestamp) - Number(tx.createdTimestamp)}s` : '—'}</b></div>
      </div>

      <p class="hint" style="margin-top:20px">
        <a href="#" data-contract="${esc(tx.recipient)}">every round against this contract</a></p>
    </div>`;
  wireLinks();

  // Asked after the record is on screen. These are extra reads against a busy
  // endpoint and the rest of the case should not wait on them.
  const slot = el('case-content');
  if (slot && call) {
    slot.innerHTML = '<h3 class="section">The case itself</h3><p class="loading">Reading the contract…</p>';
    const found = await readCase(tx.recipient, call);
    if (!found) {
      slot.innerHTML = `<h3 class="section">The case itself</h3>
        <p class="hint">This contract does not answer any of the getters this page knows, so what
        the case was about cannot be read from outside. The record above is still complete.</p>`;
    } else {
      slot.innerHTML = `
        <h3 class="section">The case itself</h3>
        <div class="pair">
          <div class="block">
            <div class="label">The claim · ${esc(found.getter)}("${esc(call.args[0])}")</div>
            ${renderFields(found.record)}
          </div>
          ${found.parent ? `
            <div class="block">
              <div class="label">Judged against · get_${esc(found.parentName)}</div>
              ${renderFields(found.parent)}
            </div>` : ''}
        </div>`;
    }
  }
}
