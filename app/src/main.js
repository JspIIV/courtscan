// Courtscan.
//
// A case record, not a transaction record. Somebody arriving with a hash wants
// to know who brought it, what they asked for, what the leader proposed, how
// each validator voted, and how it ended. All of that is on chain and none of
// it is put together anywhere.
//
// Two rules underneath it. A stranger with no wallet, no account and no GEN
// gets their answer in the time the page takes to load, because everything is a
// read. And a verdict is never shown as standing unless it stands: a round can
// finalise perfectly happily with its answer thrown away, and those two cases
// look identical everywhere else.
import './style.css';
import {
  ASSAY, CONSENSUS, EXAMPLE, REPO, client, classify, el, esc, handlers,
  leaderSaid, MEANING, readCall, remember, rpc, seenRounds, short, TONE, wireLinks,
} from './lib.js';
import { showRound } from './round.js';

let snapshot = null;

const app = document.createElement('main');
document.body.append(app);

app.innerHTML = `
  <div class="topbar">
    <div class="wordmark"><span class="dot"></span>Courtscan</div>
    <a href="${REPO}" target="_blank" rel="noreferrer">source</a>
    <div class="net"><b>GenLayer Asimov</b> · chain 4221</div>
  </div>

  <section class="hero">
    <p class="eyebrow">A case record, not a transaction</p>
    <h1>Every verdict on GenLayer,<br /><span class="soft">and whether it actually stands.</span></h1>
    <p class="lede">Who brought it, what they asked for, what the leader proposed, how each
    validator voted, and how it ended. All of it is on chain. None of it is put together anywhere
    else, and an explorer will tell you a round finalised without telling you it decided nothing.</p>
    <div class="search">
      <input id="q" placeholder="Search a round id or a contract address" spellcheck="false" autocomplete="off" />
      <button id="go">Look it up</button>
    </div>
    <p class="hint">No wallet, no account, nothing to connect. Try
      <a href="#" id="example"><code>${short(EXAMPLE)}</code></a>, a round that finalised
      and decided nothing.</p>
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
  <p class="note">Watching rounds tells you <em>that</em> one failed. It cannot tell you <em>why</em>,
  because how much work a contract asked its validators to do is invisible from outside. Every
  builder writing an Intelligent Contract has to guess how much evidence they can put in front of
  validators before a round stops coming back, and there is nowhere to look it up. So
  <strong>Assay</strong> runs the same round on purpose with one thing changed: a page cut to an
  exact size, an exact number of fields required to match.</p>

  <div class="finding">
    <div class="finding-head">What it has found so far, and it is a negative</div>
    <p><strong>Neither axis breaks agreement.</strong> A round carrying 12,000 characters agreed.
    A round requiring four separate fields to match agreed. So the two things a contract author
    most obviously controls are not what kills a round, and the frontier below is empty because
    nothing has been bracketed yet, not because the table is broken.</p>
    <p>The one real failure behind this whole project looks different from every probe: that
    contract asked its validators to <strong>compose a judgement</strong>, with a decision, a named
    precedent and a sentence written on the spot. Assay asks them to <strong>pick from a list</strong>.
    Generating prose under a clock is a different cost from choosing, and that is the next axis to
    build in. One supporting case is a hypothesis, not a finding, and it is labelled as one.</p>
  </div>

  <div class="panel" style="margin-top:12px"><div id="assay" class="loading">Reading the lab…</div></div>

  <footer>
    <a href="${REPO}" target="_blank" rel="noreferrer">source</a>
    <span>Assay <code>${short(ASSAY)}</code></span>
    <span>consensus <code>${short(CONSENSUS)}</code></span>
    <span>reads only, on GenLayer Asimov</span>
  </footer>`;

// ------------------------------------------------------------- the contract

async function showContract(address) {
  el('result').innerHTML = '<div class="verdict"><p class="loading">Reading that contract…</p></div>';

  // Asked of the chain, not of the sample. The first thing anybody wants to
  // know about an address is whether there is a contract at it at all.
  let code = null;
  let balance = null;
  try {
    const [codeHex, balanceHex] = await Promise.all([
      rpc('eth_getCode', [address, 'latest']),
      rpc('eth_getBalance', [address, 'latest']),
    ]);
    code = Math.max(0, (String(codeHex).length - 2) / 2);
    balance = Number(BigInt(balanceHex)) / 1e18;
  } catch { /* the facts are optional; the rounds are not */ }

  const rows = seenRounds.filter((r) => r.contract.toLowerCase() === address.toLowerCase());
  const agreed = rows.filter((r) => r.outcome === 'AGREED').length;
  const settled = rows.filter((r) => r.outcome !== 'IN_FLIGHT').length;
  const callers = new Set(rows.map((r) => r.sender).filter(Boolean));
  const tally = {};
  for (const r of rows) tally[r.outcome] = (tally[r.outcome] || 0) + 1;
  const isContract = code !== null && code > 0;

  const facts = `
    <div class="cards" style="margin:18px 0 6px">
      <div class="stat"><span>On chain</span>
        <b class="${isContract ? 'good' : ''}">${code === null ? '—' : (isContract ? 'contract' : 'no code')}</b>
        <small>${code === null ? 'could not be read' : `${code} bytes of code`}</small></div>
      <div class="stat"><span>Balance</span><b>${balance === null ? '—' : balance}</b><small>GEN</small></div>
      <div class="stat"><span>Rounds seen here</span><b>${rows.length}</b>
        <small>${settled ? `${((agreed / settled) * 100).toFixed(0)}% agreed` : 'none settled'}</small></div>
      <div class="stat"><span>Distinct callers</span><b>${callers.size || '—'}</b>
        <small>among those rounds</small></div>
    </div>`;

  if (!rows.length) {
    el('result').innerHTML = `
      <div class="verdict">
        <div class="verdict-head">
          <div class="mark">·</div>
          <div class="headline"><h2 class="outcome">${esc(short(address))}</h2>
          <p>${isContract
    ? 'A contract lives here. None of its rounds fall in what this page has decoded.'
    : 'No code at this address on this network.'}</p></div>
        </div>
        ${facts}
        <p class="hint">The window is the sample plus the last 150 blocks, so this means "not in
          what was looked at", never "never". A round id can always be looked up directly.</p>
      </div>`;
    return;
  }

  const pills = Object.entries(tally).sort((a, b) => b[1] - a[1])
    .map(([o, n]) => `<span class="pill ${TONE[o] || 'muted'}">${esc(o)} ${n}</span>`).join(' ');

  el('result').innerHTML = `
    <div class="verdict ${settled && agreed === settled ? 'good' : ''}">
      <div class="verdict-head">
        <div class="mark ${settled && agreed === settled ? 'good' : ''}">${isContract ? '⬢' : '·'}</div>
        <div class="headline">
          <h2 class="outcome">${esc(short(address))}</h2>
          <p>${rows.length} round${rows.length === 1 ? '' : 's'} decoded here,
            ${agreed} of them agreed.</p>
        </div>
      </div>
      ${facts}
      <p class="hint" style="margin:14px 0 0">${pills}</p>
      <div class="scroll" style="margin-top:14px"><table>
        <thead><tr><th>Outcome</th><th>Round</th><th>Brought by</th><th>What the leader said</th></tr></thead>
        <tbody>${rows.map((r) => `
          <tr>
            <td><span class="pill ${TONE[r.outcome] || 'muted'}">${esc(r.outcome)}</span></td>
            <td><a href="#" data-round="${esc(r.id)}">${esc(short(r.id))}</a></td>
            <td class="said">${esc(short(r.sender || '')) || '<span class="dim">—</span>'}</td>
            <td class="said">${esc((r.leader_said || '').slice(0, 60)) || '<span class="dim">not in the outputs</span>'}</td>
          </tr>`).join('')}</tbody>
      </table></div>
    </div>`;
  wireLinks();
}

handlers.round = showRound;
handlers.contract = showContract;

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
el('example').onclick = (e) => { e.preventDefault(); el('q').value = EXAMPLE; lookup(); };

// --------------------------------------------------------------------- data

(async () => {
  try { snapshot = await (await fetch('/sample.json')).json(); } catch { /* optional */ }
  if (snapshot && snapshot.rounds) remember(snapshot.rounds);

  const rate = snapshot ? snapshot.agreement_rate : null;
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

  if (snapshot) {
    const rows = Object.entries(snapshot.tally || {}).sort((a, b) => b[1] - a[1]).map(
      ([o, n]) => `<tr><td><span class="pill ${TONE[o] || 'muted'}">${esc(o)}</span></td>
        <td>${n}</td><td class="muted">${esc(MEANING[o] || '')}</td></tr>`).join('');
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

  try {
    const head = Number(await rpc('eth_blockNumber', []));
    const logs = await rpc('eth_getLogs', [{
      fromBlock: `0x${(head - 150).toString(16)}`, toBlock: 'latest', address: CONSENSUS,
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
        if (tx && tx.recipient && tx.recipient !== `0x${'0'.repeat(40)}`) {
          found.push({ id, tx, outcome: classify(tx) });
        }
      } catch { /* most topics are not round ids */ }
    }
    remember(found.map((f) => ({
      id: f.id, contract: f.tx.recipient, sender: f.tx.sender || '',
      outcome: f.outcome, leader_said: leaderSaid(f.tx),
    })));
    el('live').className = '';
    el('live').innerHTML = found.length ? `
      <div class="scroll"><table>
        <thead><tr><th>Outcome</th><th>Contract</th><th>Round</th><th>Asked for</th><th>Validators</th></tr></thead>
        <tbody>${found.map((f) => {
    const call = readCall(f.tx.txCalldata || f.tx.txData);
    return `
          <tr>
            <td><span class="pill ${TONE[f.outcome] || 'muted'}">${esc(f.outcome)}</span></td>
            <td><a href="#" data-contract="${esc(f.tx.recipient)}">${esc(short(f.tx.recipient))}</a></td>
            <td><a href="#" data-round="${esc(f.id)}">${esc(short(f.id))}</a></td>
            <td class="said">${call && call.method ? esc(call.method) : '<span class="dim">—</span>'}</td>
            <td class="muted">${esc(f.tx.numOfInitialValidators || 0)}</td>
          </tr>`;
  }).join('')}</tbody>
      </table></div>`
      : '<p class="loading">No rounds in the last 150 blocks. The network is quiet just now.</p>';
    wireLinks();
  } catch (e) {
    el('live').className = '';
    el('live').innerHTML = `<p class="loading bad">Could not scan recent blocks: ${esc(e.message)}</p>`;
  }

  try {
    const frontier = JSON.parse(await client.readContract({
      address: ASSAY, functionName: 'get_frontier', args: [],
    }));
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
