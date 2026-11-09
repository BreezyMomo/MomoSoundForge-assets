import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';

test('catalog builds retry a temporary 503 without changing pinned file integrity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'momo-download-test-'));
  const patch = join(root, 'patch'), output = join(root, 'site');
  await mkdir(patch);
  const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
  const graph = { schema: 'momo.resource-graph/v1', renderContract: 'momo.engine/1', entry: { id: 'test', kind: 'synth' }, root: 'node-' + 'a'.repeat(64), objects: {}, annotations: {} };
  const bytes = gzipSync(JSON.stringify(graph)), file = 'graph.bin';
  const entry = { ...graph.entry, file, sha256: sha256(bytes), bytes: bytes.length, decodedBytes: Buffer.byteLength(JSON.stringify(graph)), contentId: graph.root };
  const base = Buffer.from(JSON.stringify({ schema: 'momo.remote-sound-library/v1', libraryId: 'momo-official-sounds', entries: [entry], audio: [] }));
  await writeFile(join(patch, 'base-index.json'), base);
  await writeFile(join(patch, 'patch.json'), JSON.stringify({ schema: 'momo.remote-sound-library-patch/v1', baseIndexSha256: sha256(base), baseIndexFile: 'base-index.json', removeEntryIds: [], replaceEntries: [entry] }));
  await writeFile(join(patch, file), bytes);
  let requests = 0;
  const server = createServer((req, res) => {
    requests++;
    if (requests === 1) { res.writeHead(503); res.end('Temporary outage'); }
    else { res.writeHead(200); res.end(bytes); }
  });
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const result = await new Promise((resolveResult, reject) => {
      const child = spawn(process.execPath, [resolve('tools/build-library.mjs'), '--base-url', `http://127.0.0.1:${port}/`, '--patch-dir', patch, '--output', output]);
      let log = '';
      child.stdout.on('data', chunk => { log += chunk; });
      child.stderr.on('data', chunk => { log += chunk; });
      child.on('error', reject);
      child.on('close', code => resolveResult({ code, log }));
    });
    assert.equal(result.code, 0, result.log);
    assert.equal(requests, 2);
    assert.match(result.log, /retrying download/);
    assert.equal(sha256(await readFile(join(output, file))), entry.sha256);
    assert.equal(JSON.parse(await readFile(join(output, 'index.json'))).entries[0].contentId, entry.contentId);
  } finally { await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); }
});
