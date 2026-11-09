import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { loadAppProtocol } from './app-protocol.mjs';

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1]);
if (!args.get('app-root') || !args.get('output')) throw Error('Pass --app-root APP_CHECKOUT --output NEW_PATCH_DIRECTORY');
const output = resolve(args.get('output'));
const cache = resolve(args.get('cache') ?? '.repair-cache');
const baseUrl = 'https://breezymomo.github.io/MomoSoundForge-assets/';
const baseSha256 = '088a04cf598c015e1ba60930c93cf7379d97ab6edb19957770f0cf43c9e50964';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
await mkdir(cache, { recursive: true });
await mkdir(output); // Never overwrite a prepared release.
await mkdir(join(output, 'remote'));
async function fetchVerified(url, hash) {
  const file = join(cache, hash);
  let bytes;
  try { bytes = await readFile(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!bytes) {
    const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(60000) });
    if (!response.ok) throw Error(`${url}: HTTP ${response.status}`);
    bytes = new Uint8Array(await response.arrayBuffer());
  }
  if (sha256(bytes) !== hash) throw Error(`${url}: SHA-256 mismatch`);
  await writeFile(file, bytes);
  return bytes;
}
const indexBytes = await fetchVerified(new URL('index.json', baseUrl), baseSha256);
const index = JSON.parse(Buffer.from(indexBytes).toString('utf8'));
const officialIds = ['instrument-vsco-flute', 'instrument-vsco-violin-section', 'instrument-vsco-cello-section', 'instrument-vsco-french-horn', 'instrument-vsco-trumpet'];
const examples = { 'example-expanded-flute': officialIds[0], 'example-expanded-violin': officialIds[1], 'example-expanded-cello': officialIds[2] };
const entries = [...officialIds, ...Object.keys(examples)].map(id => {
  const entry = index.entries.find(e => e.id === id);
  if (!entry) throw Error(`Missing catalog entry: ${id}`);
  return entry;
});
const graphs = new Map();
for (const entry of entries) {
  const packed = await fetchVerified(new URL(entry.file, baseUrl), entry.sha256);
  graphs.set(entry.id, JSON.parse(gunzipSync(packed)));
}

// Recovery only: the original patch accidentally embedded keyRange as a literal.
// New output always goes through the editor's sealer and strict opener.
function recoverPayload(graph) {
  const inflate = (value, path, ancestors = new Set()) => {
    if (Array.isArray(value)) return value.map((item, i) => inflate(item, `${path}/${i}`, ancestors));
    if (!value || typeof value !== 'object') return value;
    let body = value, stack = ancestors;
    if (typeof value.$ref === 'string') {
      if (Object.keys(value).length !== 1 || !graph.objects[value.$ref] || ancestors.has(value.$ref)) throw Error(`Invalid recovery reference at ${path}`);
      body = graph.objects[value.$ref].value;
      stack = new Set([...ancestors, value.$ref]);
    }
    const out = Object.fromEntries(Object.entries(body).map(([key, item]) => [key, inflate(item, `${path}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`, stack)]));
    if (value.$ref) Object.assign(out, graph.annotations[path]);
    return out;
  };
  return inflate({ $ref: graph.root }, '');
}

const protocol = await loadAppProtocol(args.get('app-root'));
try {
  const audioEntries = new Map(index.audio.map(a => [a.audioId, a]));
  const rawAudio = new Map();
  const refs = new Set();
  function collect(value) {
    if (!value || typeof value !== 'object') return;
    if (value.schema === 'momo.audio-reference/v1') refs.add(value.audioId);
    Object.values(value).forEach(collect);
  }
  graphs.forEach(collect);
  const queue = [...refs]; let cursor = 0, complete = 0;
  await Promise.all(Array.from({ length: 16 }, async () => {
    for (;;) {
      const id = queue[cursor++]; if (!id) return;
      const entry = audioEntries.get(id);
      if (!entry) throw Error(`Missing audio: ${id}`);
      const packed = await fetchVerified(new URL(entry.file, baseUrl), entry.sha256);
      rawAudio.set(id, new Uint8Array(gunzipSync(packed)));
      protocol.registerAudioProvider(id, async () => pcm(id));
      if (++complete % 100 === 0 || complete === queue.length) console.log(`Verified audio transport ${complete}/${queue.length}`);
    }
  }));
  function pcm(id) {
    const entry = audioEntries.get(id), raw = rawAudio.get(id);
    if (!entry || !raw) throw Error(`Missing audio bytes: ${id}`);
    return entry.format === 'pcm' ? raw : protocol.builtinPCM(raw, entry);
  }
  const reader = asset => Promise.resolve(pcm(asset.reference.audioId));
  const repaired = new Map(), replaced = [], evidence = [];
  for (const entry of entries) {
    const graph = graphs.get(entry.id);
    let resource = protocol.parseResource({ ...graph.entry, schema: 'momo.sound-resource/v1', payload: recoverPayload(graph) });
    let before;
    if (examples[entry.id]) {
      const project = protocol.resourceProject(resource);
      before = protocol.renderProject(await protocol.prepareProjectSamples(project), 48000);
      const definition = repaired.get(examples[entry.id]).payload;
      function completeInstruments(project) {
        for (const layer of project.inputs) {
          if (layer.player.mix) completeInstruments(layer.player.mix);
          if (!layer.player.score) continue;
          layer.player.score.instruments = layer.player.score.instruments.map(old => {
            const complete = structuredClone(definition.instrument);
            const existing = new Map(old.regions.map(region => [region.id, region]));
            // Keep the demonstration's envelope and tuning while using the full
            // recordings and adding every missing pitch/velocity mapping.
            complete.regions = complete.regions.map(region => ({ ...region, ...existing.get(region.id), assetId: region.assetId }));
            return { ...complete, id: old.id, name: old.name };
          });
          Object.assign(project.assets, structuredClone(definition.assets));
        }
        const used = new Set(project.inputs.flatMap(l => [l.player.assetId, ...(l.player.score?.instruments.flatMap(i => i.regions.flatMap(r => [r.assetId, r.releaseAssetId])) ?? [])]).filter(Boolean));
        project.assets = Object.fromEntries(Object.entries(project.assets).filter(([id]) => used.has(id)));
      }
      completeInstruments(project);
      resource = protocol.parseResource({ ...resource, payload: protocol.projectDocument(project) });
    } else {
      // These are complete original recordings, not the old four-second previews.
      for (const asset of Object.values(resource.payload.assets)) delete asset.reference.frameLimit;
      // The source audit quarantined CelloEnsTrem018 and FHornStac028/056.
      // Reuse the healthy lower dynamic at the same recorded pitch for only
      // the uncovered velocities; keep all existing takes and ranges intact.
      const fallbacks = entry.id === 'instrument-vsco-cello-section'
        ? [['cello-section-celloenstrem-005', 63, 127]]
        : entry.id === 'instrument-vsco-french-horn'
          ? [['french-horn-fhornstac-020', 84, 127]] : [];
      for (const [source, low, high] of fallbacks) {
        const region = resource.payload.instrument.regions.find(r => r.id === source);
        if (!region) throw Error(`Missing healthy fallback ${source}`);
        resource.payload.instrument.regions.push({ ...region, id: `${source}-fallback-${low}-${high}`, velocityLow: low, velocityHigh: high });
      }
    }
    const fixed = await protocol.sealResource(resource, async () => {}, reader);
    const opened = await protocol.openResourceGraph(fixed);
    repaired.set(entry.id, opened.resource);
    let defaultPcmUnchanged;
    if (before) {
      const project = protocol.resourceProject(opened.resource);
      const issues = protocol.projectScoreIssues(project);
      if (issues.length) throw Error(`${entry.id}: default score issues ${JSON.stringify(issues)}`);
      const after = protocol.renderProject(await protocol.prepareProjectSamples(project), 48000);
      defaultPcmUnchanged = Buffer.from(before.left.buffer).equals(Buffer.from(after.left.buffer)) && Buffer.from(before.right.buffer).equals(Buffer.from(after.right.buffer));
      // Adding unused mappings must not unexpectedly change a demonstration.
      if (!defaultPcmUnchanged) throw Error(`${entry.id}: default rendering changed`);
    }
    const decoded = Buffer.from(JSON.stringify(fixed)), packed = gzipSync(decoded, { mtime: 0 });
    const hash = sha256(packed), file = `remote/${hash}.graph.bin`;
    await writeFile(join(output, file), packed);
    replaced.push({ ...entry, contentId: fixed.root, file, sha256: hash, bytes: packed.length, decodedBytes: decoded.length });
    evidence.push({ id: entry.id, contentId: fixed.root, audio: opened.audio.size, defaultPcmUnchanged });
    console.log(`Repaired ${entry.id}: ${opened.audio.size} audio dependencies${before ? ', default PCM unchanged' : ''}`);
  }
  const patch = { schema: 'momo.remote-sound-library-patch/v1', baseIndexSha256: baseSha256, baseIndexFile: 'base-index.json', removeEntryIds: [], replaceEntries: replaced };
  await writeFile(join(output, 'base-index.json'), indexBytes);
  await writeFile(join(output, 'patch.json'), JSON.stringify(patch, null, 2) + '\n');
  await writeFile(join(output, 'repair-evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
} finally { await protocol.close(); }
