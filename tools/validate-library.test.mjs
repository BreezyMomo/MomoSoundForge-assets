import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { loadAppProtocol } from './app-protocol.mjs';

test('publisher accepts a complete graph and rejects inline objects, velocity holes and unsupported long notes', async () => {
  assert.ok(process.env.PROTOCOL_APP_ROOT, 'Set PROTOCOL_APP_ROOT to the pinned application checkout');
  const appRoot = resolve(process.env.PROTOCOL_APP_ROOT);
  const protocol = await loadAppProtocol(appRoot);
  const site = await mkdtemp(join(tmpdir(), 'momo-publisher-test-'));
  try {
    await mkdir(join(site, 'remote'));
    const digest = bytes => createHash('sha256').update(bytes).digest('hex');
    async function store(raw) {
      const bytes = gzipSync(raw), sha256 = digest(bytes), file = `remote/${sha256}.bin`;
      await writeFile(join(site, file), bytes);
      return { file, sha256, bytes: bytes.length, decodedBytes: raw.length };
    }
    const asset = { id: 'sample', name: 'Test', sampleRate: 8000, channels: [protocol.encodeSamples(new Float32Array(8000).fill(0.1))] };
    const region = { id: 'region', assetId: asset.id, rootMidi: 60, keyLow: 60, keyHigh: 61, velocityLow: 1, velocityHigh: 127, articulation: 'sustain', roundRobin: 0, tuneCents: 0, gainDb: 0, releaseSeconds: 0.1 };
    const definition = { schema: 'momo.instrument/v1', assets: { sample: asset }, instrument: { id: 'instrument', name: 'Test', keyRange: { low: 60, high: 61 }, regions: [region] } };
    const audio = new Map(), entries = [];
    async function seal(resource) {
      return protocol.sealResource(resource, async (ref, raw) => audio.set(ref.audioId, { ...ref, format: 'pcm', ...await store(raw) }));
    }
    async function add(graph) {
      entries.push({ ...graph.entry, contentId: graph.root, ...await store(Buffer.from(JSON.stringify(graph))) });
    }
    await add(await seal(protocol.resourceFromDefinition(definition, 'test-complete')));
    const inline = await seal(protocol.resourceFromDefinition(definition, 'test-inline'));
    // Rehash the malformed graph: transfer and object hashes alone must not
    // accidentally pass an invalid inline object like the orchestra regression.
    const rebuilt = {};
    async function rewrite(id) {
      const object = structuredClone(inline.objects[id]);
      if (object.kind === 'instrument') object.value.keyRange = { low: 60, high: 61 };
      async function refs(value) {
        if (Array.isArray(value)) return Promise.all(value.map(refs));
        if (value && typeof value === 'object') {
          if (value.$ref) return { $ref: await rewrite(value.$ref) };
          return value;
        }
        return value;
      }
      for (const key of Object.keys(object.value)) object.value[key] = await refs(object.value[key]);
      const next = await protocol.contentId(object.kind, object);
      rebuilt[next] = object;
      return next;
    }
    inline.root = await rewrite(inline.root); inline.objects = rebuilt;
    await add(inline);
    const hole = structuredClone(definition);
    hole.instrument.regions[0].velocityLow = 63;
    await add(await seal(protocol.resourceFromDefinition(hole, 'instrument-vsco-flute')));
    const project = protocol.makeProject('Unsupported long note');
    project.duration = 3; project.assets = definition.assets;
    project.inputs = [protocol.makeLayer({ type: 'instrument', duration: 3, score: { schema: 'momo.score/v1', bpm: 60, instruments: [definition.instrument], notes: [{ id: 'long', instrumentId: 'instrument', midi: 60, velocity: 62, articulation: 'sustain', start: 0, duration: 2 }] } })];
    await add(await seal(protocol.resourceFromProject(project, [], 'test-long-note')));
    await writeFile(join(site, 'index.json'), JSON.stringify({ schema: 'momo.remote-sound-library/v1', libraryId: 'publisher-tests', name: 'Publisher tests', entries, audio: [...audio.values()] }));
    const reportPath = join(site, 'report.json');
    const result = spawnSync(process.execPath, [resolve('tools/validate-library.mjs'), '--app-root', appRoot, '--site', site, '--report', reportPath], { encoding: 'utf8' });
    assert.equal(result.status, 1, result.stderr + result.stdout);
    const report = JSON.parse(await readFile(reportPath, 'utf8'));
    assert.equal(report.entries, 1);
    assert.ok(report.noteFixtures > 0);
    assert.deepEqual(report.failures.map(f => f.id).sort(), ['instrument-vsco-flute', 'test-inline', 'test-long-note']);
    assert.match(report.failures.find(f => f.id === 'test-inline').error, /resources.invalid/);
    assert.match(report.failures.find(f => f.id === 'instrument-vsco-flute').error, /coverage hole/);
    assert.match(report.failures.find(f => f.id === 'test-long-note').error, /score.noSustain/);
  } finally { await protocol.close(); await rm(site, { recursive: true, force: true }); }
});
