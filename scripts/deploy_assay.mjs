// Deploy the Assay contract (with the compose axis) to GenLayer Asimov.
//   ASSAY_KEY=ppub ASSAY_KEYSTORE_PASS=... node scripts/deploy_assay.mjs
// Writes the new address to run/assay-v2-deploy.json without touching deployment.json.
//
// Note on gas: this contract is large enough that genlayer-js's deploy gas
// estimate lands above the node's 100M per-transaction cap and the deploy is
// refused with "gas limit too high". The SDK does not expose a gas override on
// deployContract, and estimateTransactionGas is called on an inner client this
// script cannot reach, so the one reliable fix is to clamp the gas the SDK
// sends. In node_modules/genlayer-js/dist/index.js, clamp each use site:
//   gas: estimatedGas,                      -> gas: (estimatedGas > 95000000n ? 95000000n : estimatedGas),
//   gas: `0x${estimatedGas.toString(16)}`   -> gas: `0x${(estimatedGas > 95000000n ? 95000000n : estimatedGas).toString(16)}`
// Only the deploy needs this; a probe's calldata is small and estimates well
// under the cap. node_modules is gitignored, so this is a local build tweak.
import { Wallet } from 'ethers';
import { createClient, createAccount } from 'genlayer-js';
import { testnetAsimov } from 'genlayer-js/chains';
import fs from 'fs'; import os from 'os'; import path from 'path'; import url from 'url';

const KS = process.env.ASSAY_KEYSTORE_DIR || path.join(os.homedir(), '.genlayer', 'keystores');
const KEY = process.env.ASSAY_KEY || 'ppub';
const PASS = process.env.ASSAY_KEYSTORE_PASS || '';
if (!PASS) { console.error('set ASSAY_KEYSTORE_PASS'); process.exit(1); }

const ROOT = path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const CONTRACT_FILE = process.env.CONTRACT_FILE || 'assay.py';
const OUT = process.env.OUT || 'assay-v2-deploy.json';
const code = fs.readFileSync(path.join(ROOT, 'contracts', CONTRACT_FILE), 'utf8');
const w = await Wallet.fromEncryptedJson(fs.readFileSync(path.join(KS, `${KEY}.json`), 'utf8'), PASS);
const client = createClient({ chain: testnetAsimov, account: createAccount(w.privateKey) });
console.log('deploying', CONTRACT_FILE, '| deployer', w.address, '| code bytes', fs.statSync(path.join(ROOT, 'contracts', CONTRACT_FILE)).size);

// The SDK sends its gas estimate (with a buffer) straight through, and for a
// large contract that estimate lands above the node's per-transaction cap
// ("gas limit too high"). Clamp it to a ceiling the node accepts; the deploy
// only needs enough EVM gas to carry the code as calldata, well under this.
const CAP = BigInt(process.env.GAS_CAP || '90000000');
const origEstimate = client.estimateTransactionGas.bind(client);
client.estimateTransactionGas = async (p) => {
  let g;
  try { g = await origEstimate(p); } catch (e) { console.log('  (estimate failed, using cap)', String(e?.message || e).slice(0, 60)); return CAP; }
  console.log('  estimated gas', g.toString(), g > CAP ? `-> clamped to ${CAP}` : '(under cap)');
  return g > CAP ? CAP : g;
};

const sleep = ms => new Promise(r => setTimeout(r, ms));
const transient = e => /-32005|-32006|-32603|at capacity|rate limit|gas rate|backpressure|fetch failed|timeout|502|503|429|ECONNRESET|ENOTFOUND|getaddrinfo/i
  .test(String(e?.details || e?.shortMessage || e?.message || e) + ' ' + String(e?.cause?.cause?.code || e?.cause?.code || ''));

let hash;
for (let a = 1; ; a++) {
  try { hash = await client.deployContract({ code, args: [] }); break; }
  catch (e) { if (!transient(e) || a >= 8) throw e; console.log(`  (deploy transient, wait ${6 * a}s)`); await sleep(6000 * a); }
}
console.log('tx', hash);

function addrFrom(r) {
  if (!r) return null;
  return r.contractAddress || r.recipient || r.data?.contract_address || r.data?.contractAddress
    || r.tx_data_decoded?.contract_address || r.consensus_data?.leader_receipt?.contract_address || null;
}
let addr = null;
for (let i = 0; i < 60; i++) {
  await sleep(5000);
  let rcpt = null;
  try { rcpt = await client.getTransactionReceipt({ hash, status: 'FINALIZED', retries: 1, interval: 1000 }); }
  catch { try { rcpt = await client.getTransaction({ hash }); } catch {} }
  addr = addrFrom(rcpt);
  if (addr) { console.log('receipt status', rcpt?.status); break; }
}
if (!addr) { console.error('no contract address in receipt after polling; check tx', hash); process.exit(1); }
console.log('DEPLOYED', addr);
fs.mkdirSync(path.join(ROOT, 'run'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'run', OUT),
  JSON.stringify({ network: 'genlayer testnet asimov', contract: CONTRACT_FILE, address: addr, tx: hash, deployer: w.address, deployed_at: new Date().toISOString() }, null, 2));
console.log('written run/' + OUT);
