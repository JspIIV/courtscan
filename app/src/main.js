// Courtscan, the page.
//
// Laid out as an explorer, because that is what somebody arriving here is
// looking for: a box to paste a round id into. It sits at the top and is the
// largest thing on the page. Everything below it is context for the answer.
//
// Two rules the whole project rests on.
//
// A stranger with no wallet, no account and no GEN gets the answer they came
// for in the time the page takes to load. Everything here is a read.
//
// And a verdict is never shown as standing unless it stands. An explorer will
// show you a finalised transaction and let you conclude a decision was made.
// Sometimes it was not: the leader answered, the validators ran out of time,
// and the answer was discarded while the transaction finalised perfectly
// happily. Those two look identical elsewhere and are opposite here.
import './style.css';
import { createClient } from 'genlayer-js';
import { testnetAsimov } from 'genlayer-js/chains';

const RPC = 'https://rpc-asimov.genlayer.com';
const CONSENSUS = '0x6CAFF6769d70824745AD895663409DC70aB5B28E';
const EXPLORER = 'https://explorer-asimov.genlayer.com';
const ASSAY = '0xbaBf2796De591Dfe9289b60bE68f4426449676fA';
const REPO = 'https://github.com/JspIIV/courtscan';

// The round that makes the case, offered as an example so nobody has to go
// looking for one: it reads as FINALIZED on the official explorer and decided
// nothing at all.
const EXAMPLE = '0x938a593d62056696702c5db81a7f61c487a970ddfc4f1eece34e676062d21545';

const client = createClient({ chain: testnetAsimov });

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const short = (s) => (s ? `${String(s).slice(0, 10)}…${String(s).slice(-6)}` : '');
const el = (id) => document.getElementById(id);

async function rpc(method, params) {
  const res = await fetch(RPC, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = await res.json();
  if (body.error) throw new Error(body.error.message);
  return body.result;
}

// The classification the whole project turns on. The node reports three
// separate things about a round and no one of them says whether a decision
// stands.
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

const MEANING = {
  AGREED: 'The validators agreed. This decision stands.',
  TIMED_OUT: 'The leader answered and the validators did not finish in time. The answer was discarded, so nothing was decided.',
  NOT_VOTED: 'The round was accepted and never voted on.',
  ERRORED: 'The round ran and ended in an error.',
  IN_FLIGHT: 'Still settling.',
  OTHER: 'The node reported something this page does not recognise.',
};
const TONE = {
  AGREED: 'good', TIMED_OUT: 'bad', ERRORED: 'bad',
  NOT_VOTED: 'warn', IN_FLIGHT: 'muted', OTHER: 'muted',
};

function leaderSaid(tx) {
  const hex = String(tx.eqBlocksOutputs || '');
  if (hex.length < 12) return '';
  let text = '';
  try {
    const bytes = new Uint8Array(hex.slice(2).match(/.{1,2}/g).map((b) => parseInt(b, 16)));
    text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  } catch { return ''; }
  const a = text.indexOf('{');
  const b = text.lastIndexOf('}');
  if (a < 0 || b <= a) return '';
  // eslint-disable-next-line no-control-regex
  const slice = text.slice(a, b + 1).replace(/[^ -~]+/g, ' ').trim();
  // The outputs are padded and the padding decodes to plausible looking words.
  // Printing one under "what the leader said" would be putting words in its
  // mouth, which is the exact failure this page exists to expose.
  return slice.length < 12 ? '' : slice;
}

const app = document.createElement('main');
document.body.append(app);

app.innerHTML = `
  <div class="topbar">
    <div class="wordmark"><span class="dot"></span>Courtscan</div>
    <a href="${REPO}" target="_blank" rel="noreferrer">source</a>
    <div class="net"><b>GenLayer Asimov</b> · chain 4221</div>
  </div>

  <section class="hero">
    <h1>Every verdict on GenLayer,<br /><span class="soft">and whether it actually stands.</span></h1>
    <p class="lede">An explorer shows you a finalised transaction. It does not tell you whether the
    validators agreed, or whether the leader answered perfectly well and the round was thrown away
    anyway. One of those is a verdict. The other is a verdict that never happened.</p>
    <div class="search">
      <input id="q" placeholder="Search a round id or a contract address" spellcheck="false" autocomplete="off" />
      <button id="go">Look it up</button>
    </div>
    <p class="hint">No wallet, no account, nothing to connect. Try
      <a href="#" id="example"><code>${short(EXAMPLE)}</code></a>, a round that reads as
      <code>FINALIZED</code> and decided nothing.</p>
    <div class="result" id="result"></div>
  </section>

  <div class="cards" id="cards"></div>

  <h2>Rounds happening now</h2>
  <div class="panel">
    <div class="head">The last 150 blocks of consensus events, decoded in your browser as this page loaded.</div>
    <div id="live" class="loading">Scanning recent blocks…</div>
  </div>

  <h2>What a sample of the network looks like</h2>
  <div id="health"></div>

  <h2>The laboratory</h2>
  <p class="note">Watching rounds tells you what happened. It cannot tell you what makes a round
  fail, because the payload inside somebody else's contract is invisible from outside. So
  <a href="${EXPLORER}/address/${ASSAY}" target="_blank" rel="noreferrer">Assay</a> runs controlled
  rounds on purpose: a page cut to an exact size, an exact number of fields required to match.
  <strong>It has not yet made a round fail.</strong> Every frontier below is unbracketed, and that
  is the honest state of it rather than a result.</p>
  <div class="panel"><div id="assay" class="loading">Reading the lab…</div></div>

  <footer>
    <a href="${EXPLORER}/address/${CONSENSUS}" target="_blank" rel="noreferrer">consensus contract</a>
    <a href="${EXPLORER}/address/${ASSAY}" target="_blank" rel="noreferrer">Assay</a>
    <a href="${REPO}" target="_blank" rel="noreferrer">source</a>
    <span>reads only, on GenLayer Asimov</span>
  </footer>`;

// ------------------------------------------------------------------ lookup

async function showRound(id) {
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
  const said = leaderSaid(tx);
  el('result').innerHTML = `
    <div class="verdict ${TONE[outcome]}">
      <span class="pill ${TONE[outcome]}">${esc(outcome)}</span>
      <p class="meaning">${esc(MEANING[outcome])}</p>
      <dl>
        <dt>contract</dt><dd>${esc(tx.recipient)}</dd>
        <dt>sender</dt><dd>${esc(tx.sender || '')}</dd>
        <dt>the node reports</dt><dd>status ${esc(tx.statusName || '-')} ·
          result ${esc(tx.resultName || '-')} · execution ${esc(tx.txExecutionResultName || '-')}</dd>
        <dt>validators</dt><dd>${esc(tx.numOfInitialValidators || 0)}, ${esc(tx.numOfRounds || 0)} rotation(s)</dd>
      </dl>
      ${said ? `<p class="said-head">What the leader said${outcome === 'TIMED_OUT'
        ? ', which was then discarded' : ''}:</p><pre><code>${esc(said)}</code></pre>` : ''}
      <p class="hint" style="margin-top:16px">
        <a href="${EXPLORER}/tx/${esc(id)}" target="_blank" rel="noreferrer">the same round on the official explorer</a></p>
    </div>`;
}

let snapshot = null;

async function showContract(address) {
  const rows = (snapshot?.rounds || []).filter(
    (r) => r.contract.toLowerCase() === address.toLowerCase());
  if (!rows.length) {
    el('result').innerHTML = `<div class="verdict"><p class="muted">No rounds against that contract
      in the current sample, which covers ${snapshot?.blocks_scanned ?? 0} blocks. That means
      "not in that window", never "never". A round id can always be looked up directly.</p></div>`;
    return;
  }
  const agreed = rows.filter((r) => r.outcome === 'AGREED').length;
  el('result').innerHTML = `
    <div class="verdict">
      <p class="meaning"><strong>${rows.length}</strong> round(s) in the sample,
        <strong>${agreed}</strong> agreed.</p>
      <div class="scroll"><table>
        <thead><tr><th>Outcome</th><th>Round</th><th>What the leader said</th></tr></thead>
        <tbody>${rows.map((r) => `
          <tr>
            <td><span class="pill ${TONE[r.outcome] || 'muted'}">${esc(r.outcome)}</span></td>
            <td><a href="${EXPLORER}/tx/${esc(r.id)}" target="_blank" rel="noreferrer">${esc(short(r.id))}</a></td>
            <td class="said">${esc((r.leader_said || '').slice(0, 80)) || '<span class="dim">not in the outputs</span>'}</td>
          </tr>`).join('')}</tbody>
      </table></div>
    </div>`;
}

function lookup() {
  const q = el('q').value.trim();
  if (/^0x[0-9a-fA-F]{64}$/.test(q)) return showRound(q);
  if (/^0x[0-9a-fA-F]{40}$/.test(q)) return showContract(q);
  el('result').innerHTML = `<div class="verdict warn"><p class="warn">That is neither a round id
    (32 bytes) nor a contract address (20 bytes).</p></div>`;
  return undefined;
}

el('go').onclick = lookup;
el('q').onkeydown = (e) => { if (e.key === 'Enter') lookup(); };
el('example').onclick = (e) => {
  e.preventDefault();
  el('q').value = EXAMPLE;
  lookup();
};

// ------------------------------------------------------------------- data

(async () => {
  try { snapshot = await (await fetch('/sample.json')).json(); } catch { /* optional */ }

  // ---- cards --------------------------------------------------------------
  const rate = snapshot?.agreement_rate;
  el('cards').innerHTML = `
    <div class="stat"><span>Agreement rate</span>
      <b class="good">${rate == null ? '—' : `${(rate * 100).toFixed(1)}%`}</b>
      <small>over ${snapshot?.settled_rounds ?? 0} settled rounds</small></div>
    <div class="stat"><span>Rounds decoded</span><b>${snapshot?.rounds_decoded ?? 0}</b>
      <small>in ${snapshot?.blocks_scanned ?? 0} blocks</small></div>
    <div class="stat"><span>Contracts seen</span><b>${snapshot?.distinct_contracts ?? 0}</b>
      <small>distinct, in that window</small></div>
    <div class="stat"><span>Sampled at block</span><b>${snapshot?.head_block ?? '—'}</b>
      <small>${esc(String(snapshot?.taken_at ?? '').slice(0, 10))}</small></div>`;

  // ---- the sample ---------------------------------------------------------
  if (snapshot) {
    const rows = Object.entries(snapshot.tally || {}).sort((a, b) => b[1] - a[1]).map(
      ([outcome, n]) => `
        <tr><td><span class="pill ${TONE[outcome] || 'muted'}">${esc(outcome)}</span></td>
        <td>${n}</td><td class="muted">${esc(MEANING[outcome] || '')}</td></tr>`).join('');
    el('health').innerHTML = `
      <div class="panel">
        <div class="head">Every contract in one window of blocks, not the whole chain.</div>
        <div class="scroll"><table>
          <thead><tr><th>Outcome</th><th>Rounds</th><th>What it means</th></tr></thead>
          <tbody>${rows}</tbody>
        </table></div>
      </div>
      <p class="caution">${esc(snapshot.caution)}</p>`;
  }

  // ---- live ---------------------------------------------------------------
  try {
    const head = Number(await rpc('eth_blockNumber', []));
    const logs = await rpc('eth_getLogs', [{
      fromBlock: '0x' + (head - 150).toString(16), toBlock: 'latest', address: CONSENSUS,
    }]);
    const ids = [];
    for (const log of logs) {
      for (const topic of (log.topics || []).slice(1)) {
        if (String(topic).length === 66 && !ids.includes(topic)) ids.push(topic);
      }
    }
    const found = [];
    for (const id of ids.slice(0, 24)) {
      try {
        const raw = await client.getTransaction({ hash: id });
        const tx = JSON.parse(JSON.stringify(raw, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
        if (tx?.recipient && tx.recipient !== '0x' + '0'.repeat(40)) {
          found.push({ id, tx, outcome: classify(tx) });
        }
      } catch { /* most topics are not round ids */ }
    }
    el('live').className = '';
    el('live').innerHTML = found.length ? `
      <div class="scroll"><table>
        <thead><tr><th>Outcome</th><th>Contract</th><th>Round</th><th>Validators</th><th>What the leader said</th></tr></thead>
        <tbody>${found.map((f) => `
          <tr>
            <td><span class="pill ${TONE[f.outcome] || 'muted'}">${esc(f.outcome)}</span></td>
            <td><a href="${EXPLORER}/address/${esc(f.tx.recipient)}" target="_blank" rel="noreferrer">${esc(short(f.tx.recipient))}</a></td>
            <td><a href="${EXPLORER}/tx/${esc(f.id)}" target="_blank" rel="noreferrer">${esc(short(f.id))}</a></td>
            <td class="muted">${esc(f.tx.numOfInitialValidators || 0)}</td>
            <td class="said">${esc(leaderSaid(f.tx).slice(0, 70)) || '<span class="dim">not in the outputs</span>'}</td>
          </tr>`).join('')}</tbody>
      </table></div>`
      : '<p class="loading">No rounds in the last 150 blocks. The network is quiet just now.</p>';
  } catch (e) {
    el('live').className = '';
    el('live').innerHTML = `<p class="loading bad">Could not scan recent blocks: ${esc(e.message)}</p>`;
  }

  // ---- the lab ------------------------------------------------------------
  try {
    const frontier = JSON.parse(await client.readContract({
      address: ASSAY, functionName: 'get_frontier', args: [] }));
    el('assay').className = '';
    el('assay').innerHTML = `
      <div class="scroll"><table>
        <thead><tr><th>Mode</th><th>Bound fields</th><th>Largest that agreed</th>
          <th>Smallest that failed</th><th>Observations</th></tr></thead>
        <tbody>${frontier.frontier.map((r) => `
          <tr><td><span class="pill muted">${esc(r.mode)}</span></td>
          <td>${r.bound_fields}</td>
          <td class="good">${r.largest_agreed ?? '—'}</td>
          <td>${r.smallest_failed ?? '<span class="dim">none yet</span>'}</td>
          <td class="muted">${r.observations}</td></tr>`).join('')
        || '<tr><td colspan="5" class="muted">no probes yet</td></tr>'}</tbody>
      </table></div>`;
  } catch (e) {
    el('assay').className = '';
    el('assay').innerHTML = `<p class="loading bad">Could not read the lab: ${esc(e.message)}</p>`;
  }
})();
