import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { id, privateDirectory, requireThat } from '../src/util.mjs';

// A disposable destination for fault tests. It never contacts another service.
// It intentionally does not deduplicate: an accidental replay becomes a second receipt.
export async function effectDestination(directory, { response = 'disconnect', observed = () => {} } = {}) {
  requireThat(['disconnect', 'hold', 'reply'].includes(response), 'Unknown controlled destination response.');
  directory = privateDirectory(directory);
  const file = path.join(directory, 'receipts.jsonl');
  const descriptor = fs.openSync(file, 'wx', 0o600);
  const route = `/${id('effect')}`;
  const server = http.createServer(async (request, reply) => {
    if (request.method !== 'POST' || request.url !== route) { reply.writeHead(404).end(); return; }
    let body = '';
    for await (const bytes of request) {
      body += bytes.toString('utf8');
      if (Buffer.byteLength(body) > 16384) { reply.writeHead(413).end(); return; }
    }
    let input;
    try { input = JSON.parse(body); } catch { reply.writeHead(400).end(); return; }
    if (typeof input.operationID !== 'string' || !input.operationID.trim()) { reply.writeHead(400).end(); return; }
    const receipt = { operationID: input.operationID, time: Date.now() };
    fs.writeSync(descriptor, `${JSON.stringify(receipt)}\n`);
    fs.fsyncSync(descriptor);
    observed(receipt);
    if (response === 'disconnect') reply.destroy();
    else if (response === 'reply') reply.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(receipt));
  });
  try { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); }); }
  catch (error) { fs.closeSync(descriptor); throw error; }
  return { url: `http://127.0.0.1:${server.address().port}${route}`, file,
    receipts: () => fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)),
    close: async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.closeSync(descriptor); } };
}
