import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, link, copyFile } from 'node:fs/promises';
import { dirname, join, resolve, relative, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync, gunzipSync } from 'node:zlib';
import { spawn } from 'node:child_process';
import { loadAppProtocol } from './app-protocol.mjs';
import { parseSfz, convertSfz } from './vcsl-sfz.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
const readJson = async file => JSON.parse(await readFile(file, 'utf8'));
const helperKeys = ['sourceIndex', 'samplePath', 'releaseSamplePath', 'bakeGainDb', 'releaseBakeGainDb', 'mixLayers', 'releaseMixLayers', 'releaseEnvelope', 'pedalState'];
const isSteinway = item => item.id === 'instrument-vcsl-grand-piano-steinway-b';

function inside(root, path) {
  const target = resolve(root, path), rel = relative(root, target);
  if (!rel || rel.startsWith('..') || resolve(path) === path) throw Error(`Unsafe output path: ${path}`);
  return target;
}

function addWarning(warnings, code, message) {
  if (!warnings.some(w => w.code === code && w.message === message)) warnings.push({ code, message });
}

export function mappingCoverage(regions) {
  const coverage = {};
  for (const articulation of new Set(regions.map(r => r.articulation))) {
    const selected = regions.filter(r => r.articulation === articulation), keys = new Set();
    selected.forEach(r => { for (let midi = r.keyLow; midi <= r.keyHigh; midi++) keys.add(midi); });
    const ranges = [];
    for (const key of [...keys].sort((a, b) => a - b)) {
      const last = ranges.at(-1);
      if (last && last[1] + 1 === key) last[1] = key; else ranges.push([key, key]);
    }
    const velocityHoles = [];
    for (const midi of keys) for (let velocity = 1; velocity <= 127; velocity++) {
      if (!selected.some(r => midi >= r.keyLow && midi <= r.keyHigh && velocity >= r.velocityLow && velocity <= r.velocityHigh)) velocityHoles.push({ midi, velocity });
    }
    coverage[articulation] = { ranges, velocityHoles };
  }
  return coverage;
}

/** Produce honest, complete variants without changing protocol/audio budgets. */
export function buildVariants(item, converted) {
  const variants = isSteinway(item) ? [
    { id: item.id, names: { zh: `${item.names.zh}（正常）`, en: `${item.names.en} (Normal)` }, pedalState: 'off' },
    { id: `${item.id}-pedal`, names: { zh: `${item.names.zh}（延音踏板）`, en: `${item.names.en} (Sustain Pedal)` }, pedalState: 'on' },
  ] : [{ id: item.id, names: item.names }];
  return variants.map(variant => {
    const warnings = [...converted.warnings], regions = structuredClone(converted.regions.filter(r => !variant.pedalState || r.pedalState === variant.pedalState));
    if (!regions.length) throw Error(`${item.id}: empty variant`);
    if (variant.pedalState) addWarning(warnings, 'complete-pedal-variant', 'The 24-bit stereo Steinway source exceeds one expanded resource budget with both pedal states. Each variant retains a complete keyboard and its own release dependencies; no resampling or budget increase is used.');
    if (item.id === 'instrument-vcsl-legacy-toms') {
      const repairs = regions.filter(r => r.keyLow <= 61 && r.keyHigh >= 61 && r.velocityHigh === 59);
      for (const r of repairs) r.velocityHigh = 60;
      if (repairs.length) addWarning(warnings, 'authored-velocity-gap-repaired', 'The author mapping omitted MIDI 61 at velocity 60. The healthy recording already covering the adjacent velocity 59 is reused through velocity 60; no new recorded velocity layer is claimed.');
    }
    let oneShots = 0;
    if (item.category === 'percussion' && !/Friction Idiophones/.test(item.sourceKey)) {
      for (const r of regions) if (!/bow|roll|tremolo|long|slow/i.test(r.articulation) && !r.releaseSamplePath) {
        r.playback = 'one-shot'; oneShots++;
      }
    }
    if (oneShots) addWarning(warnings, 'percussion-one-shot', 'Struck percussion plays its complete recorded tail independently of note-off. Bowed, rolled and sustained friction articulations retain gated playback.');
    const coverage = mappingCoverage(regions);
    const holes = Object.entries(coverage).flatMap(([articulation, c]) => c.velocityHoles.map(h => ({ articulation, ...h })));
    if (holes.length) throw Error(`${item.id}: unsupported velocity holes: ${JSON.stringify(holes.slice(0, 10))}`);
    return { ...variant, manifestId: item.id, regions, warnings, coverage,
      keyRange: { low: Math.min(...regions.map(r => r.keyLow)), high: Math.max(...regions.map(r => r.keyHigh)) } };
  });
}

export function localizedLabels(item, converted, dictionary, regions) {
  const names = {};
  for (const id of new Set(regions.map(r => r.articulation))) {
    const value = dictionary.instruments?.[item.id]?.[id] ?? dictionary.names?.[id];
    if (!value || typeof value.zh !== 'string' || !value.zh.trim() || typeof value.en !== 'string' || !value.en.trim()) throw Error(`${item.id}: missing bilingual articulation ${id} (${converted.labels[id]?.en ?? id})`);
    names[id] = { zh: value.zh, en: value.en };
  }
  return names;
}

function regionPeak(region, main, release) {
  const peaks = [main.stats.peak * 10 ** (region.gainDb / 20)];
  if (release) peaks.push(release.stats.peak * 10 ** (region.releaseVoice.gainDb / 20));
  return Math.max(...peaks);
}

export function instrumentHeadroom(bindings) {
  const hasRelease = bindings.some(b => b.release), target = hasRelease ? .35 : .7;
  const before = Math.max(...bindings.map(b => regionPeak(b.region, b.main, b.release)));
  if (!Number.isFinite(before) || before <= 0) throw Error('Invalid or silent complete instrument');
  return { globalGainDb: Math.min(0, 20 * Math.log10(target / before)), targetPerVoicePeak: target, peakBefore: before };
}

async function linkVerified(source, target) {
  await mkdir(dirname(target), { recursive: true });
  try { await link(source, target); }
  catch (error) {
    if (error.code === 'EEXIST') {
      if (sha256(await readFile(source)) !== sha256(await readFile(target))) throw Error(`Immutable output conflict: ${target}`);
    } else if (['EXDEV', 'EPERM', 'ENOTSUP'].includes(error.code)) await copyFile(source, target);
    else throw error;
  }
}

async function runVerifier(appRoot, directory) {
  const child = spawn(process.execPath, ['--max-old-space-size=8192', fileURLToPath(import.meta.url), '--verify-dir', directory, '--app-root', appRoot], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let stdout = '', stderr = '';
  child.stdout.on('data', b => { stdout += b; if (stdout.length > 1024 * 1024) stdout = stdout.slice(-1024 * 1024); });
  child.stderr.on('data', b => { stderr += b; if (stderr.length > 1024 * 1024) stderr = stderr.slice(-1024 * 1024); });
  const status = await new Promise((resolveStatus, reject) => { child.once('error', reject); child.once('exit', resolveStatus); });
  if (status !== 0) throw Error(`Instrument verification failed (${status}): ${stderr}\n${stdout}`);
  return readJson(join(directory, 'verification.json'));
}

async function importVariant(item, variant, converted, context) {
  const { protocol, audio, lock, source, dictionary, originalCache, audioCache, output, appRoot, mappings } = context;
  const directory = inside(output, variant.id);
  await mkdir(join(directory, 'remote'), { recursive: true });
  const existing = await readJson(join(directory, 'report.json')).catch(e => e.code === 'ENOENT' ? undefined : Promise.reject(e));
  const fingerprint = sha256(Buffer.from(json({ item, variant: { id: variant.id, pedalState: variant.pedalState }, labels: dictionary, mappings, version: 1 })));
  if (existing?.status === 'validated' && existing.buildFingerprint === fingerprint && !context.force) {
    const entry = await readJson(join(directory, 'entry.json'));
    for (const file of [entry, ...await readJson(join(directory, 'audio.json'))]) {
      const bytes = await readFile(inside(directory, file.file));
      if (bytes.length !== file.bytes || sha256(bytes) !== file.sha256) throw Error(`${variant.id}: corrupted resumed output ${file.file}`);
    }
    console.log(`Reused validated ${variant.id}`);
    return existing;
  }
  console.log(`Preparing ${variant.id}: ${variant.regions.length} mappings`);
  const originals = new Map(), preparedById = new Map();
  async function original(path) {
    if (!originals.has(path)) {
      const item = lock.get(path);
      if (!item) throw Error(`Missing locked original ${path}`);
      originals.set(path, await audio.prepareOriginal(item, { originalCache, pcmCache: audioCache }));
    }
    return originals.get(path);
  }
  async function layers(values, rootMidi) {
    return audio.mixPrepared(await Promise.all(values.map(async layer => ({ ...layer, prepared: await original(layer.samplePath) }))), rootMidi, audioCache);
  }
  const bindings = [];
  for (const raw of variant.regions) {
    const region = structuredClone(raw);
    const main = raw.mixLayers ? await layers(raw.mixLayers, raw.rootMidi)
      : Math.abs(raw.bakeGainDb) > 1e-10 ? await audio.bakePrepared(await original(raw.samplePath), { gainDb: raw.bakeGainDb }, audioCache) : await original(raw.samplePath);
    let release;
    if (raw.releaseMixLayers) release = await layers(raw.releaseMixLayers, raw.releaseVoice.rootMidi);
    else if (raw.releaseSamplePath) release = await audio.bakePrepared(await original(raw.releaseSamplePath), {
      gainDb: raw.releaseVoice.gainDb + raw.releaseBakeGainDb,
      offset: raw.releaseVoice.offset, envelope: raw.releaseEnvelope,
    }, audioCache);
    if (release) region.releaseVoice = { ...region.releaseVoice, gainDb: 0, offset: 0 };
    bindings.push({ region, main, release, sourcePath: raw.samplePath, releaseSourcePath: raw.releaseSamplePath });
  }
  const headroom = instrumentHeadroom(bindings), attenuated = new Map();
  async function attenuate(prepared) {
    if (!attenuated.has(prepared.audioId)) attenuated.set(prepared.audioId, headroom.globalGainDb < -1e-10 ? await audio.bakePrepared(prepared, { gainDb: headroom.globalGainDb }, audioCache) : prepared);
    return attenuated.get(prepared.audioId);
  }
  const assets = {}, regions = [];
  function addAsset(prepared, sourcePath) {
    const id = `sample-${prepared.audioId.slice(6)}`;
    preparedById.set(prepared.audioId, prepared);
    const originalItem = lock.get(sourcePath);
    const encodedPath = sourcePath.split('/').map(encodeURIComponent).join('/');
    assets[id] ??= { id, name: basename(sourcePath).slice(0, 120), sampleRate: prepared.reference.sampleRate, channels: [], reference: prepared.reference,
      source: { provider: 'VCSL', url: `${source.repository}/blob/${source.commit}/${encodedPath}`, author: 'Versilian Studios LLC',
        license: source.license, licenseUrl: source.licenseUrl, quality: 'original', retrievedAt: '2026-11-09T00:00:00.000Z' } };
    if (!originalItem) throw Error(`Missing asset provenance ${sourcePath}`);
    return id;
  }
  for (const binding of bindings) {
    const main = await attenuate(binding.main), release = binding.release && await attenuate(binding.release);
    const region = { ...binding.region, assetId: addAsset(main, binding.sourcePath) };
    if (release) region.releaseAssetId = addAsset(release, binding.releaseSourcePath);
    helperKeys.forEach(key => delete region[key]);
    regions.push(region);
  }
  const articulationNames = localizedLabels(item, converted, dictionary, regions);
  const definition = { schema: 'momo.instrument/v1', instrument: { id: variant.id, name: variant.names.zh,
    source: `${source.repository}/tree/${source.commit}/${item.sourceKey.split('/').map(encodeURIComponent).join('/')}`,
    license: source.license, keyRange: variant.keyRange, articulationNames, regions }, assets };
  const resource = protocol.resourceFromDefinition(definition, variant.id);
  resource.category = item.category;
  resource.description = 'VCSL · CC0 · complete instrument mapping. See the library source and validation report for conversion details.';
  const audioRecords = new Map();
  const reader = async asset => {
    const prepared = preparedById.get(asset.reference?.audioId);
    if (!prepared) throw Error(`Missing prepared audio ${asset.id}`);
    return audio.loadPrepared(prepared);
  };
  const graph = await protocol.sealResource(resource, async ref => {
    const prepared = preparedById.get(ref.audioId);
    if (!prepared) throw Error(`Sealer produced unknown audio ${ref.audioId}`);
    const file = `remote/${prepared.sha256}.pcm.bin`;
    await linkVerified(prepared.file, inside(directory, file));
    audioRecords.set(ref.audioId, { audioId: ref.audioId, sampleRate: ref.sampleRate, channelCount: ref.channelCount, frames: ref.frames,
      format: 'pcm', file, sha256: prepared.sha256, bytes: prepared.bytes, decodedBytes: prepared.decodedBytes });
  }, reader);
  const opened = await protocol.openResourceGraph(graph);
  if (opened.audio.size !== audioRecords.size) throw Error(`${variant.id}: incomplete dependency closure`);
  const raw = Buffer.from(JSON.stringify(graph)), packed = gzipSync(raw), graphSha = sha256(packed), graphFile = `remote/${graphSha}.graph.bin`;
  await writeFile(inside(directory, graphFile), packed);
  const entry = { ...graph.entry, names: variant.names, contentId: graph.root, file: graphFile, sha256: graphSha, bytes: packed.length, decodedBytes: raw.length };
  await writeFile(join(directory, 'entry.json'), json(entry));
  await writeFile(join(directory, 'audio.json'), json([...audioRecords.values()]));
  const pcmBytes = [...audioRecords.values()].reduce((n, a) => n + a.decodedBytes, 0);
  if (pcmBytes > protocol.PACKAGE_EXPANDED_BYTES) throw Error(`${variant.id}: expanded package exceeds unchanged resource budget`);
  const sourceRecords = [...originals.values()].map(p => ({ path: p.sourcePath, gitBlob: p.sha, sha256: p.originalSha256, audioId: p.audioId }));
  const report = { schema: 'momo.vcsl-instrument-report/v1', status: 'pending-validation', buildFingerprint: fingerprint,
    id: variant.id, manifestId: item.id, names: variant.names, category: item.category, batch: item.batch, suggestedLibrary: item.suggestedLibrary,
    ...(variant.pedalState ? { pedalState: variant.pedalState } : {}),
    source: { ...source, mappings, originals: sourceRecords },
    regions: regions.length, audio: audioRecords.size, graphBytes: raw.length, pcmBytes,
    transferBytes: packed.length + [...audioRecords.values()].reduce((n, a) => n + a.bytes, 0),
    ...headroom, warnings: variant.warnings, coverage: variant.coverage, articulationNames,
    mappingConversions: variant.regions,
  };
  await writeFile(join(directory, 'report.json'), json(report));
  const validation = await runVerifier(appRoot, directory);
  report.status = 'validated'; report.validation = validation;
  await writeFile(join(directory, 'report.json'), json(report));
  console.log(`Validated ${variant.id}: ${audioRecords.size} audio, ${(report.transferBytes / 1048576).toFixed(1)} MiB, ${validation.noteFixtures} note fixtures`);
  return report;
}

function validationCases(instrument) {
  const result = [];
  for (const articulation of new Set(instrument.regions.map(r => r.articulation))) {
    const rs = instrument.regions.filter(r => r.articulation === articulation), keys = [];
    for (const r of rs) for (let k = r.keyLow; k <= r.keyHigh; k++) keys.push(k);
    const sorted = [...new Set(keys)].sort((a, b) => a - b);
    for (const midi of [...new Set([sorted[Math.floor(sorted.length / 2)], sorted[0], sorted.at(-1)])]) result.push({ articulation, midi, velocity: 90 });
  }
  return result;
}

function noteProject(protocol, template, test) {
  const project = structuredClone(template), instrument = project.inputs[0].player.score.instruments[0];
  project.seed = 12345; project.master = 1; project.echo = 0;
  const score = { schema: 'momo.score/v1', bpm: 60, instruments: [instrument], notes: [] };
  const note = { id: 'validation-note', instrumentId: instrument.id, ...test, start: 0, duration: .08 };
  const region = protocol.selectRegion(instrument, note, 2048, new Map());
  if (!region) throw Error('No region for validation note');
  const asset = project.assets[region.assetId];
  const rate = 2 ** (((region.fixedPitch ? 0 : note.midi - region.rootMidi) + region.tuneCents / 100) / 12);
  const available = (protocol.sampleFrames(asset) - (region.sampleOffset ?? 0)) / asset.sampleRate / rate;
  note.duration = Math.min(.08, available / 4);
  const end = protocol.noteEndSeconds(note, region, project.assets, 60);
  score.notes = [note];
  const duration = Math.max(.1, end + .01);
  project.duration = duration;
  project.inputs = [protocol.makeLayer({ id: 'validation-layer', name: instrument.name, type: 'instrument', score, duration,
    gain: 1, attack: 0, release: 0, decay: 0, cutoff: 22000, noiseSeed: 2048 })];
  const issues = protocol.projectScoreIssues(project);
  if (issues.length) throw Error(`Validation project issues: ${JSON.stringify(issues)}`);
  return project;
}

/** Each verifier runs in its own process so unpacked large-package providers are released. */
export async function verifyInstrumentDirectory(directory, appRoot) {
  const protocol = await loadAppProtocol(appRoot);
  try {
    const entry = await readJson(join(directory, 'entry.json')), records = await readJson(join(directory, 'audio.json'));
    const byId = new Map(records.map(a => [a.audioId, a]));
    const packedGraph = await readFile(inside(directory, entry.file));
    if (packedGraph.length !== entry.bytes || sha256(packedGraph) !== entry.sha256) throw Error('Graph transport mismatch');
    const graph = JSON.parse(gunzipSync(packedGraph)), opened = await protocol.openResourceGraph(graph);
    if (graph.root !== entry.contentId) throw Error('Graph content mismatch');
    const reader = async asset => {
      const record = byId.get(asset.reference.audioId);
      if (!record) throw Error('Incomplete package dependency');
      const bytes = await readFile(inside(directory, record.file));
      if (bytes.length !== record.bytes || sha256(bytes) !== record.sha256) throw Error('Audio transfer mismatch');
      return new Uint8Array(gunzipSync(bytes));
    };
    for (const [id, ref] of opened.audio) {
      const record = byId.get(id);
      if (!record || record.frames !== ref.frames || record.sampleRate !== ref.sampleRate || record.channelCount !== ref.channelCount) throw Error('Audio descriptor mismatch');
      protocol.registerAudioProvider(id, async () => new Uint8Array(gunzipSync(await readFile(inside(directory, record.file)))));
    }
    const template = protocol.resourceProject(opened.resource), instrument = template.inputs[0].player.score.instruments[0];
    let noteFixtures = 0;
    for (const region of instrument.regions) for (const midi of new Set([region.keyLow, region.keyHigh])) for (const velocity of new Set([region.velocityLow, region.velocityHigh])) {
      const variants = instrument.regions.filter(r => r.articulation === region.articulation && r.keyLow === region.keyLow && r.keyHigh === region.keyHigh && r.velocityLow === region.velocityLow && r.velocityHigh === region.velocityHigh).length;
      for (let seed = 0; seed < variants; seed++) {
        const note = { id: 'boundary', instrumentId: instrument.id, articulation: region.articulation, midi, velocity, start: 0, duration: .01 };
        const chosen = protocol.selectRegion(instrument, note, seed, new Map()), asset = template.assets[chosen.assetId];
        const rate = 2 ** (((chosen.fixedPitch ? 0 : midi - chosen.rootMidi) + chosen.tuneCents / 100) / 12);
        const available = (protocol.sampleFrames(asset) - (chosen.sampleOffset ?? 0)) / asset.sampleRate / rate;
        for (const duration of [Math.min(.05, available / 4), Math.max(available * .9, available - chosen.releaseSeconds - .02)]) {
          const test = { ...note, duration }, end = protocol.noteEndSeconds(test, chosen, template.assets, 60);
          const issues = protocol.scoreIssues({ schema: 'momo.score/v1', bpm: 60, instruments: [instrument], notes: [test] }, template.assets, end + .01, seed);
          if (issues.length) throw Error(`Boundary issue ${JSON.stringify({ midi, velocity, duration, issues })}`);
          noteFixtures++;
        }
      }
    }
    const cases = validationCases(instrument), firstProject = noteProject(protocol, template, cases[0]);
    const saved = await protocol.packProject(firstProject, reader);
    if (saved.length > protocol.PACKAGE_BYTES) throw Error('Sharing package exceeds unchanged package budget');
    const reopened = await protocol.unpackProject(saved);
    const pcmHash = rendered => createHash('sha256').update(Buffer.from(rendered.left.buffer, rendered.left.byteOffset, rendered.left.byteLength)).update(Buffer.from(rendered.right.buffer, rendered.right.byteOffset, rendered.right.byteLength)).digest('hex');
    const renders = [];
    for (let i = 0; i < cases.length; i++) {
      const before = protocol.renderProject(await protocol.prepareProjectSamples(noteProject(protocol, template, cases[i])), 44100);
      const after = protocol.renderProject(await protocol.prepareProjectSamples(noteProject(protocol, reopened, cases[i])), 44100);
      if (!before.left.some(v => v !== 0) || !before.right.some(v => v !== 0)) throw Error(`Silent rendered note ${JSON.stringify(cases[i])}`);
      if (before.peak > .701) throw Error(`Unsafe rendered peak ${before.peak}`);
      const hash = pcmHash(before);
      if (hash !== pcmHash(after)) throw Error('Save/reopen changed rendered PCM');
      const wav = protocol.encodeWav(before);
      if (i === 0) await writeFile(join(directory, 'audition.wav'), new Uint8Array(wav));
      renders.push({ ...cases[i], pcmSha256: hash, wavSha256: sha256(new Uint8Array(wav)), peak: before.peak, frames: before.left.length });
    }
    const report = { strictGraph: true, completePackageRoundTrip: true, packageBytes: saved.length,
      audio: opened.audio.size, noteFixtures, renderedCases: renders.length, renders, audition: 'audition.wav',
      subjectiveListening: 'Not yet assessed; automated waveform/peak checks do not constitute an audition.' };
    await writeFile(join(directory, 'verification.json'), json(report));
    return report;
  } finally { await protocol.close(); }
}

export async function runImport(options) {
  const plan = await readJson(options.manifest ?? join(repo, 'sources/vcsl-instruments.json'));
  const sourceLock = await readJson(options.lock ?? join(repo, 'sources/vcsl-source-lock.json'));
  const dictionary = await readJson(options.labels ?? join(repo, 'sources/vcsl-articulation-names.json'));
  const lock = new Map(sourceLock.files.map(f => [f.path, f]));
  const audio = await import('./vcsl-audio.mjs');
  const mappingRoot = resolve(options.mappingRoot ?? join(repo, 'sources/vcsl/sfz'));
  const requested = options.ids ? new Set(options.ids.split(',').filter(Boolean)) : undefined;
  const items = plan.instruments.filter(item => !item.existing && (!options.batch || item.batch === options.batch)
    && (!requested || requested.has(item.id) || isSteinway(item) && requested.has(`${item.id}-pedal`)));
  if (!items.length) throw Error('No new instruments selected');
  const output = resolve(options.output);
  await mkdir(output, { recursive: true });
  const protocol = await loadAppProtocol(options.appRoot);
  const reports = [], failures = [];
  try {
    for (const item of items) {
      try {
        if (item.sfz.length !== 1) throw Error('Select exactly one author mapping per complete instrument');
        const mappingPath = item.sfz[0], mappingBytes = await readFile(inside(mappingRoot, mappingPath));
        const recorded = item.sourceMappings.find(m => m.path === mappingPath);
        const hash = sha256(mappingBytes);
        if (!recorded || recorded.sha256 !== hash) throw Error(`Author mapping SHA-256 mismatch: ${mappingPath}`);
        const converted = convertSfz(parseSfz(mappingBytes.toString('utf8'), { path: mappingPath }), { samplePathRemap: item.samplePathRemap, articulation: item.defaultArticulation });
        for (const variant of buildVariants(item, converted)) {
          if (requested && !requested.has(item.id) && !requested.has(variant.id)) continue;
          reports.push(await importVariant(item, variant, converted, { protocol, audio, lock, source: plan.source, dictionary,
            originalCache: resolve(options.originalCache), audioCache: resolve(options.audioCache), output,
            appRoot: resolve(options.appRoot), mappings: [{ path: mappingPath, sha256: hash, gitBlob: recorded.gitBlob }], force: options.force }));
        }
      } catch (error) {
        console.error(`${item.id}: ${error.stack ?? error}`);
        failures.push({ id: item.id, error: error.message });
      }
    }
    const summary = { schema: 'momo.vcsl-import-report/v1', requested: items.length, completed: reports.length,
      reusedExisting: plan.instruments.filter(i => i.existing).map(i => i.id),
      instruments: reports.map(({ id, regions, audio, transferBytes, pcmBytes }) => ({ id, regions, audio, transferBytes, pcmBytes })), failures };
    await writeFile(join(output, 'import-summary.json'), json(summary));
    return summary;
  } finally { await protocol.close(); }
}

async function main() {
  const args = {};
  for (let i = 2; i < process.argv.length; i++) {
    const key = process.argv[i];
    if (!key.startsWith('--')) throw Error('Expected --key value');
    const next = process.argv[i + 1];
    args[key.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = next && !next.startsWith('--') ? process.argv[++i] : true;
  }
  if (!args.appRoot) throw Error('Pass --app-root PINNED_APP');
  if (args.verifyDir) {
    console.log(json(await verifyInstrumentDirectory(resolve(args.verifyDir), resolve(args.appRoot))));
    return;
  }
  if (!args.originalCache || !args.audioCache || !args.output) throw Error('Pass --original-cache DIR --audio-cache DIR --output NEW_INSTRUMENT_DIRECTORY');
  const summary = await runImport(args);
  console.log(json(summary));
  if (summary.failures.length) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.stack ?? error); process.exitCode = 1; });
