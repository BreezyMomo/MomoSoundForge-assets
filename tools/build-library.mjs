#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, relative, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';

const args = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  const value = process.argv[i];
  if (!value.startsWith('--')) continue;
  const next = process.argv[i + 1];
  args.set(value.slice(2), next && !next.startsWith('--') ? next : true);
  if (next && !next.startsWith('--')) i += 1;
}

const baseUrl = String(args.get('base-url') ?? 'https://breezymomo.github.io/MomoSoundForge-assets/').replace(/\/?$/, '/');
const patchDir = resolve(String(args.get('patch-dir') ?? '.patch'));
const output = resolve(String(args.get('output') ?? '_audio-site'));
const concurrency = Math.max(1, Math.min(32, Number(args.get('concurrency') ?? 24)));
const json = value => JSON.stringify(value, null, 2) + '\n';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const safePath = value => {
  const clean = normalize(value);
  if (clean.startsWith('..') || clean.includes('\\') || clean.startsWith('/') || clean.includes(':')) throw new Error(`unsafe path: ${value}`);
  return clean;
};
const readJson = async file => JSON.parse(await readFile(file, 'utf8'));

async function fetchBytes(url, expected, label) {
  const response = await fetch(url, { redirect: 'error' });
  if (!response.ok) throw new Error(`${label}: HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (expected !== undefined && sha256(bytes) !== expected) throw new Error(`${label}: SHA-256 mismatch`);
  return bytes;
}

async function writeRemote(file, bytes) {
  const target = join(output, safePath(file));
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, bytes);
}

async function runPool(items, worker) {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      await worker(items[index], index);
    }
  });
  await Promise.all(workers);
}

function collectAudioIds(value, found = new Set()) {
  if (!value || typeof value !== 'object') return found;
  if (Array.isArray(value)) {
    for (const item of value) collectAudioIds(item, found);
    return found;
  }
  if (value.schema === 'momo.audio-reference/v1' && typeof value.audioId === 'string') found.add(value.audioId);
  for (const item of Object.values(value)) collectAudioIds(item, found);
  return found;
}

async function verifyGraph(entry, audioIds) {
  const bytes = await readFile(join(output, safePath(entry.file)));
  if (sha256(bytes) !== entry.sha256) throw new Error(`${entry.id}: graph SHA-256 mismatch`);
  const graph = JSON.parse(gunzipSync(bytes));
  if (graph.schema !== 'momo.resource-graph/v1' || graph.renderContract !== 'momo.engine/1' ||
      graph.root !== entry.contentId || graph.entry?.id !== entry.id || graph.entry?.kind !== entry.kind) {
    throw new Error(`${entry.id}: graph header mismatch`);
  }
  if (!/^node-[a-f0-9]{64}$/.test(graph.root)) throw new Error(`${entry.id}: invalid graph root`);
  for (const id of collectAudioIds(graph)) if (!audioIds.has(id)) throw new Error(`${entry.id}: missing audio dependency ${id}`);
}

const patch = await readJson(join(patchDir, 'patch.json'));
if (patch.schema !== 'momo.remote-sound-library-patch/v1' || !/^[a-f0-9]{64}$/.test(patch.baseIndexSha256) ||
    !Array.isArray(patch.removeEntryIds) || !Array.isArray(patch.replaceEntries)) throw new Error('invalid patch manifest');

const indexBytes = await fetchBytes(new URL('index.json', baseUrl), patch.baseIndexSha256, 'base index');
const base = JSON.parse(new TextDecoder().decode(indexBytes));
if (base.schema !== 'momo.remote-sound-library/v1' || base.libraryId !== 'momo-official-sounds') throw new Error('invalid base library');
const removeIds = new Set(patch.removeEntryIds);
const replaceIds = new Set(patch.replaceEntries.map(entry => entry.id));
if (replaceIds.size !== patch.replaceEntries.length || [...removeIds].some(id => replaceIds.has(id))) throw new Error('patch id collision');
const firstRemoved = base.entries.findIndex(entry => removeIds.has(entry.id));
if (firstRemoved < 0 || removeIds.size !== base.entries.filter(entry => removeIds.has(entry.id)).length) throw new Error('patch base entries missing');

await rm(output, { recursive: true, force: true });
await mkdir(join(output, 'remote'), { recursive: true });
const removedFiles = new Set(base.entries.filter(entry => removeIds.has(entry.id)).map(entry => entry.file));
const files = [
  ...base.entries.filter(entry => !removedFiles.has(entry.file)).map(entry => ({ file: entry.file, sha256: entry.sha256 })),
  ...base.audio.map(entry => ({ file: entry.file, sha256: entry.sha256 })),
];
const uniqueFiles = [...new Map(files.map(file => [file.file, file])).values()];
let complete = 0;
await runPool(uniqueFiles, async item => {
  const bytes = await fetchBytes(new URL(item.file, baseUrl), item.sha256, item.file);
  await writeRemote(item.file, bytes);
  complete += 1;
  if (complete % 100 === 0 || complete === uniqueFiles.length) console.log(`Fetched ${complete}/${uniqueFiles.length}`);
});

const patchFiles = [];
for (const entry of patch.replaceEntries) {
  const file = safePath(entry.file);
  const source = join(patchDir, file);
  const bytes = await readFile(source);
  if (sha256(bytes) !== entry.sha256 || bytes.length !== entry.bytes) throw new Error(`${entry.id}: patch graph mismatch`);
  await writeRemote(file, bytes);
  patchFiles.push(file);
}

const entries = base.entries.filter(entry => !removeIds.has(entry.id) && !replaceIds.has(entry.id));
entries.splice(firstRemoved, 0, ...patch.replaceEntries);
const entryIds = new Set();
for (const entry of entries) {
  if (entryIds.has(entry.id)) throw new Error(`duplicate entry ${entry.id}`);
  entryIds.add(entry.id);
}
const next = { ...base, entries };
await writeFile(join(output, 'index.json'), json(next));

const audioIds = new Set(base.audio.map(entry => entry.audioId));
await runPool(entries, async entry => verifyGraph(entry, audioIds));
const replacedExisting = base.entries.filter(entry => replaceIds.has(entry.id)).length;
if (entries.some(entry => removeIds.has(entry.id)) || entries.length !== base.entries.length - removeIds.size - replacedExisting + patch.replaceEntries.length) throw new Error('entry patch was not applied');
console.log(`Built ${entries.length} entries and ${base.audio.length} audio dependencies`);
console.log(`Patched graph files: ${patchFiles.length}`);
