import { createClient } from 'genlayer-js';
import { testnetAsimov } from 'genlayer-js/chains';
import fs from 'node:fs';

const client = createClient({ chain: testnetAsimov });
const ids = process.argv.slice(2);
for (const id of ids) {
  try {
    const tx = await client.getTransaction({ hash: id });
    const name = id.slice(2, 10);
    fs.writeFileSync(`tests/fixtures/${name}.json`, JSON.stringify(tx, (k, v) =>
      typeof v === 'bigint' ? v.toString() : v, 2));
    console.log('saved', name, tx.statusName, tx.txExecutionResultName,
      'eq', String(tx.eqBlocksOutputs || '').length, 'data', String(tx.txData || '').length);
  } catch (e) { console.log('FAILED', id, String(e.message).slice(0, 80)); }
}
