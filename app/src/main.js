// Courtscan, the page.
//
// Two rules, and they are the same two the whole project rests on.
//
// A stranger with no wallet, no account and no GEN gets the answer they came
// for in the time the page takes to load. Everything here is a read.
//
// And a verdict is never shown as standing unless it stands. A block explorer
// will show you a finalised transaction and let you conclude a decision was
// made. Sometimes it was not: the leader answered, the validators ran out of
// time, and the answer was discarded with the transaction still finalising
// perfectly happily. Those two cases look identical there and are opposite
// here.
import './style.css';
import { createClient } from 'genlayer-js';
import { testnetAsimov } from 'genlayer-js/chains';

const RPC = 'https://rpc-asimov.genlayer.com';
const CONSENSUS = '0x6CAFF6769d70824745AD895663409DC70aB5B28E';
const EXPLORER = 'https://explorer-asimov.genlayer.com';
const ASSAY = '0xbaBf2796De591Dfe9289b60bE68f4426449676fA';

const client = createClient({ chain: testnetAsimov });

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const short = (s) => (s ? `${String(s).slice(0, 10)}…${String(s).slice(-6)}` : '');

async function rpc(method, params) {
  const res = await fetch(RPC, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = await res.json();
  if (body.error) throw new Error(body.error.message);
  return body.result;
}

// The same classification the indexer uses, and the reason this project exists.
// The node reports three separate things about a round and no one of them says
// whether a decision stands.
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
  AGREED: 'the validators agreed. This decision stands.',
  TIMED_OUT: 'the leader answered and the validators did not finish in time. The answer was discarded: nothing was decided.',
  NOT_VOTED: 'the round was accepted and never voted on.',
  ERRORED: 'the round ran and ended in an error.',
  IN_FLIGHT: 'still settling.',
  OTHER: 'the node reported something this page does not recognise.',
};
const TONE = { AGREED: 'good', TIMED_OUT: 'bad', ERRORED: 'bad', NOT_VOTED: 'warn', IN_FLIGHT: 'muted', OTHER: 'muted' };

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
  if (a < 0 || b <= a) return '';   // there is no object in there to read
  // eslint-disable-next-line no-control-regex
  const slice = text.slice(a, b + 1).replace(/[^ -~]+/g, ' ').trim();
  // The outputs are padded, and the padding decodes to plausible looking words.
  // Showing "padded" in a column headed "what the leader said" would be putting
  // words in its mouth, which is the exact failure this whole page is about.
  return slice.length < 12 ? '' : slice.slice(0, 320);
}

const app = document.createElement('main');
document.body.append(app);
const el = (id) => document.getElementById(id);

app.innerHTML = `
  <header>
    <h1>Courtscan</h1>
    <p class="lede">Every verdict on GenLayer, and whether it actually stands.</p>
  </header>
  <p class="loading">Reading the chain…</p>`;

(async () => {
  let snapshot = null;
  try { snapshot = await (await fetch('/sample.json')).json(); } catch { /* optional */ }

  app.innerHTML = `
    <header>
      <h1>Courtscan</h1>
      <p class="lede">Every verdict on GenLayer, and whether it actually stands.</p>
    </header>

    <section class="intro">
      <p>A block explorer shows you a finalised transaction. It does not tell you the one
      thing that matters about a consensus round: <strong>did the validators agree, or did
      the leader answer perfectly well and the round get thrown away anyway?</strong> Those
      two look identical there. One is a verdict. The other is a verdict that never
      happened.</p>
      <p class="note">This is not hypothetical. On 19 August 2026 a round on this network
      produced a considered answer from its leader, finalised as <code>TIMEOUT</code>, and
      discarded it. Read from the explorer, it looks like a decision was made.</p>
    </section>

    <section id="health"></section>

    <h2>Look up a round or a contract</h2>
    <div class="row">
      <input id="q" placeholder="a round id, or a contract address" spellcheck="false" />
      <button id="go" class="act">Look it up</button>
    </div>
    <p class="note">No wallet, no account, nothing to connect. Everything on this page is a read.</p>
    <div id="result"></div>

    <h2>Rounds happening now</h2>
    <p class="note">The last few hundred blocks of consensus events, decoded live in your browser.</p>
    <div id="live" class="loading">Scanning recent blocks…</div>

    <h2>The laboratory</h2>
    <p class="note">Watching rounds tells you what happened. It does not tell you what makes a
    round fail, because the payload of somebody else's contract is not visible from outside.
    So <a href="${EXPLORER}/address/${ASSAY}" target="_blank" rel="noreferrer">Assay</a> runs
    controlled rounds on purpose: a page cut to an exact size, an exact number of fields
    required to match, and a record of where agreement stops.</p>
    <div id="assay" class="loading">Reading the lab…</div>

    <footer>
      <a href="${EXPLORER}/address/${CONSENSUS}" target="_blank" rel="noreferrer">the consensus contract</a>
      · <a href="https://github.com/JspIIV/courtscan" target="_blank" rel="noreferrer">source</a>
      · <span class="muted">reads only, on GenLayer Asimov</span>
    </footer>`;

  // ---- the sampled health of the network ----------------------------------

  if (snapshot) {
    const rate = snapshot.agreement_rate;
    const rows = Object.entries(snapshot.tally || {})
      .sort((a, b) => b[1] - a[1])
      .map(([outcome, n]) => `
        <tr><td class="${TONE[outcome] || ''}">${esc(outcome)}</td>
        <td>${n}</td><td class="muted">${esc(MEANING[outcome] || '')}</td></tr>`).join('');
    el('health').innerHTML = `
      <h2>What a sample of the network looks like</h2>
      <section class="strip">
        <div><span>Rounds decoded</span><b>${snapshot.rounds_decoded}</b></div>
        <div><span>Agreed</span><b>${rate === null ? '—' : `${(rate * 100).toFixed(1)}%`}</b></div>
        <div><span>Distinct contracts</span><b>${snapshot.distinct_contracts}</b></div>
        <div><span>Blocks scanned</span><b>${snapshot.blocks_scanned}</b></div>
      </section>
      <div class="scroll"><table>
        <thead><tr><th>Outcome</th><th>Rounds</th><th>What it means</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
      <p class="caution">${esc(snapshot.caution)} Taken at block ${snapshot.head_block},
      ${esc(String(snapshot.taken_at).slice(0, 16).replace('T', ' '))} UTC. Rerun the indexer in the
      repository to take your own.</p>`;
  } else {
    el('health').innerHTML = '';
  }

  // ---- lookup --------------------------------------------------------------

  async function showRound(id) {
    el('result').innerHTML = '<p class="loading">Reading that round…</p>';
    let tx;
    try {
      const raw = await client.getTransaction({ hash: id });
      tx = JSON.parse(JSON.stringify(raw, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
    } catch (e) {
      el('result').innerHTML = `<p class="bad">Could not read it: ${esc(e.message)}</p>`;
      return;
    }
    if (!tx || !tx.recipient) {
      el('result').innerHTML = '<p class="bad">The node has no round under that id.</p>';
      return;
    }
    const outcome = classify(tx);
    const said = leaderSaid(tx);
    el('result').innerHTML = `
      <div class="card">
        <span class="badge ${TONE[outcome]}">${esc(outcome)}</span>
        <p class="meaning">${esc(MEANING[outcome])}</p>
        <dl>
          <dt>contract</dt><dd><code>${esc(tx.recipient)}</code></dd>
          <dt>sender</dt><dd><code>${esc(tx.sender || '')}</code></dd>
          <dt>the node reports</dt><dd>status <code>${esc(tx.statusName || '-')}</code>,
            result <code>${esc(tx.resultName || '-')}</code>,
            execution <code>${esc(tx.txExecutionResultName || '-')}</code></dd>
          <dt>validators</dt><dd>${esc(tx.numOfInitialValidators || 0)}, ${esc(tx.numOfRounds || 0)} rotation(s)</dd>
        </dl>
        ${said ? `<p class="note"><strong>What the leader said</strong>${outcome === 'TIMED_OUT'
          ? ', which was then discarded' : ''}:</p><pre><code>${esc(said)}</code></pre>` : ''}
        <p class="note"><a href="${EXPLORER}/tx/${esc(id)}" target="_blank" rel="noreferrer">the same round on the official explorer</a></p>
      </div>`;
  }

  async function showContract(address) {
    el('result').innerHTML = `<p class="loading">Looking for rounds against
      <code>${esc(address)}</code> in the sample…</p>`;
    const rows = (snapshot?.rounds || []).filter(
      (r) => r.contract.toLowerCase() === address.toLowerCase());
    if (!rows.length) {
      el('result').innerHTML = `<p class="note">No rounds against that contract in the current
        sample. The sample covers ${snapshot?.blocks_scanned ?? 0} blocks, so this means
        "not in that window", not "never". Paste a round id to look one up directly.</p>`;
      return;
    }
    const agreed = rows.filter((r) => r.outcome === 'AGREED').length;
    el('result').innerHTML = `
      <div class="card">
        <p><strong>${rows.length}</strong> round(s) in the sample, <strong>${agreed}</strong> agreed.</p>
        <div class="scroll"><table>
          <thead><tr><th>Outcome</th><th>Round</th><th>What the leader said</th></tr></thead>
          <tbody>${rows.map((r) => `
            <tr>
              <td class="${TONE[r.outcome] || ''}">${esc(r.outcome)}</td>
              <td><a href="${EXPLORER}/tx/${esc(r.id)}" target="_blank" rel="noreferrer"><code>${esc(short(r.id))}</code></a></td>
              <td class="muted">${esc((r.leader_said || '').slice(0, 90))}</td>
            </tr>`).join('')}</tbody>
        </table></div>
      </div>`;
  }

  el('go').onclick = () => {
    const q = el('q').value.trim();
    if (/^0x[0-9a-fA-F]{64}$/.test(q)) return showRound(q);
    if (/^0x[0-9a-fA-F]{40}$/.test(q)) return showContract(q);
    el('result').innerHTML = '<p class="bad">That is neither a round id (32 bytes) nor an address (20 bytes).</p>';
    return undefined;
  };
  el('q').onkeydown = (e) => { if (e.key === 'Enter') el('go').click(); };

  // ---- the live feed -------------------------------------------------------

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
      } catch { /* not a round id, which most topics are not */ }
    }
    el('live').className = '';
    el('live').innerHTML = found.length ? `
      <p class="note">${found.length} round(s) found in the last 150 blocks, out of
      ${logs.length} consensus events.</p>
      <div class="scroll"><table>
        <thead><tr><th>Outcome</th><th>Contract</th><th>Round</th><th>What the leader said</th></tr></thead>
        <tbody>${found.map((f) => `
          <tr>
            <td class="${TONE[f.outcome] || ''}">${esc(f.outcome)}</td>
            <td><code>${esc(short(f.tx.recipient))}</code></td>
            <td><a href="${EXPLORER}/tx/${esc(f.id)}" target="_blank" rel="noreferrer"><code>${esc(short(f.id))}</code></a></td>
            <td class="muted">${esc(leaderSaid(f.tx).slice(0, 90))}</td>
          </tr>`).join('')}</tbody>
      </table></div>`
      : '<p class="note">No rounds in the last 150 blocks. The network is quiet just now.</p>';
  } catch (e) {
    el('live').className = '';
    el('live').innerHTML = `<p class="bad">Could not scan recent blocks: ${esc(e.message)}</p>`;
  }

  // ---- the lab -------------------------------------------------------------

  try {
    const raw = await client.readContract({ address: ASSAY, functionName: 'get_frontier', args: [] });
    const frontier = JSON.parse(raw);
    el('assay').className = '';
    el('assay').innerHTML = `
      <div class="scroll"><table>
        <thead><tr><th>Mode</th><th>Bound fields</th><th>Largest agreed</th>
          <th>Smallest failed</th><th>Observations</th></tr></thead>
        <tbody>${frontier.frontier.map((r) => `
          <tr><td><code>${esc(r.mode)}</code></td><td>${r.bound_fields}</td>
          <td>${r.largest_agreed ?? '—'}</td><td>${r.smallest_failed ?? '—'}</td>
          <td class="muted">${r.observations}</td></tr>`).join('')
        || '<tr><td colspan="5" class="muted">no probes yet</td></tr>'}</tbody>
      </table></div>
      <p class="caution">${esc(frontier.caution)}</p>`;
  } catch (e) {
    el('assay').className = '';
    el('assay').innerHTML = `<p class="bad">Could not read the lab: ${esc(e.message)}</p>`;
  }
})();
