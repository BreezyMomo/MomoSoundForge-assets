import { createHash } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, writeFile, link, copyFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep, posix } from 'node:path';

const PLAN = new URL('../sources/vcsl-instruments.json', import.meta.url);
const LIMIT = 850 * 1024 * 1024;
const HARD_LIMIT = 1024 * 1024 * 1024;
const own = v => v && typeof v === 'object' && !Array.isArray(v);
const die = message => { throw new Error(`assemble-vcsl: ${message}`); };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const cleanId = value => /^[a-z0-9][a-z0-9-]{0,119}$/.test(value);

function args(argv) {
  const out = new Map();
  for (let i = 2; i < argv.length; i++) {
    if (!argv[i].startsWith('--') || !argv[i + 1]) die('usage: --instruments DIR --output DIR');
    out.set(argv[i].slice(2), argv[++i]);
  }
  if (!out.has('instruments') || !out.has('output')) die('usage: --instruments DIR --output DIR');
  return out;
}
async function files(root, current = root) {
  const out = [];
  for (const item of await readdir(current, { withFileTypes: true })) {
    const full = join(current, item.name), st = await lstat(full);
    if (st.isSymbolicLink()) die(`symlink is not allowed: ${full}`);
    if (st.isDirectory()) out.push(...await files(root, full));
    else if (st.isFile()) out.push({ path: full, rel: relative(root, full).split(sep).join('/'), bytes: st.size });
    else die(`special file is not allowed: ${full}`);
  }
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}
async function readJson(path) { try { return JSON.parse(await readFile(path, 'utf8')); } catch (e) { die(`invalid JSON ${path}: ${e.message}`); } }
function safeRelative(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.startsWith('/') || value.split('/').some(x => !x || x === '.' || x === '..')) die(`unsafe output path ${value}`);
  return value;
}
async function install(source, target) {
  await mkdir(dirname(target), { recursive: true });
  try { await link(source, target); } catch { await copyFile(source, target); }
}

function validateReport(report, path) {
  if (!own(report) || report.schema !== 'momo.vcsl-instrument-report/v1' || report.status !== 'validated') die(`${path} is not a validated report`);
  if (!cleanId(report.id) || !cleanId(report.manifestId) || !own(report.names) || typeof report.names.zh !== 'string' || typeof report.names.en !== 'string') die(`${path} has invalid identity or names`);
  // import-vcsl records coverage by articulation directly:
  // { sustain: { ranges, velocityHoles }, ... }. Keep the report and the
  // published validation-scope shape aligned so every articulation is checked.
  if (!own(report.coverage) || !Object.keys(report.coverage).length) die(`${path} has no coverage`);
  for (const [articulation, value] of Object.entries(report.coverage)) {
    if (!own(value) || !Array.isArray(value.ranges) || !value.ranges.length || value.ranges.some(range => !Array.isArray(range) || range.length !== 2 || !range.every(Number.isInteger))) {
      die(`${path} has invalid coverage for ${articulation}`);
    }
    if (value.velocityHoles?.length) die(`${path} has velocity holes in ${articulation}`);
  }
  if (!Number.isInteger(report.regions) || report.regions < 1 || !Number.isInteger(report.audio) || report.audio < 0) die(`${path} has no dependency records`);
}

async function loadInstrument(root, dir) {
  const folder = join(root, dir), reportPath = join(folder, 'report.json');
  const report = await readJson(reportPath); validateReport(report, reportPath);
  const entry = await readJson(join(folder, 'entry.json'));
  if (!own(entry) || entry.id !== report.id || !cleanId(entry.id) || typeof entry.file !== 'string' || !entry.file.startsWith('remote/')) die(`${dir}: invalid entry.json`);
  if (!Array.isArray(entry.preview)) entry.preview = [];
  const audio = await readJson(join(folder, 'audio.json'));
  if (!Array.isArray(audio)) die(`${dir}: audio.json must be an array`);
  const localFiles = await files(folder);
  return { folder, dir, report, entry, audio, localFiles };
}

function nameFor(base, index) {
  // suggestedLibrary values are already prefixed with `vcsl-`; repository
  // names carry that prefix exactly once (MomoSoundForge-assets-vcsl-winds).
  const slug = base.startsWith('vcsl-') ? base.slice(5) : base;
  return index === 0 ? `MomoSoundForge-assets-vcsl-${slug}` : `MomoSoundForge-assets-vcsl-${slug}-${index + 1}`;
}

async function main() {
  const options = args(process.argv), root = resolve(options.get('instruments')), output = resolve(options.get('output'));
  const plan = await readJson(fileURLToPath(PLAN));
  if (!Array.isArray(plan.instruments)) die('source plan has no instruments');
  const planById = new Map(plan.instruments.map(x => [x.id, x]));
  const dirs = (await readdir(root, { withFileTypes: true })).filter(x => x.isDirectory()).map(x => x.name).sort();
  if (!dirs.length) die(`no instrument directories under ${root}`);
  const instruments = [];
  for (const dir of dirs) {
    const loaded = await loadInstrument(root, dir);
    const source = planById.get(loaded.report.manifestId);
    if (!source) die(`${dir}: manifestId is absent from source plan`);
    loaded.source = source; instruments.push(loaded);
  }
  const groups = new Map();
  for (const instrument of instruments) {
    const key = instrument.source.suggestedLibrary || instrument.report.suggestedLibrary || 'misc';
    if (!groups.has(key)) groups.set(key, []); groups.get(key).push(instrument);
  }
  const assemblies = [];
  for (const [base, members] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    const chunks = [];
    for (const member of members.sort((a, b) => a.report.id.localeCompare(b.report.id))) {
      const ownBytes = member.localFiles.reduce((sum, f) => sum + f.bytes, 0);
      let chunk = chunks.at(-1);
      if (!chunk || chunk.bytes + ownBytes > LIMIT) { chunk = { bytes: 0, members: [] }; chunks.push(chunk); }
      chunk.members.push(member); chunk.bytes += ownBytes;
    }
    chunks.forEach((chunk, index) => assemblies.push({ base, name: nameFor(base, index), members: chunk.members }));
  }
  await mkdir(output, { recursive: true });
  const report = { schema: 'momo.vcsl-assembly-report/v1', sourcePlan: relative(output, fileURLToPath(PLAN)).split(sep).join('/'), createdAt: new Date().toISOString(), sites: [] };
  for (const assembly of assemblies) {
    const site = join(output, assembly.name);
    try { await lstat(site); die(`output already exists: ${site}`); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const remote = join(site, 'remote'), provenance = join(site, 'provenance');
    await mkdir(remote, { recursive: true }); await mkdir(provenance, { recursive: true });
    const entries = [], audioById = new Map(), copied = new Map(), coverage = {};
    for (const member of assembly.members) {
      const { entry, report: instrumentReport, folder } = member;
      const graphFile = safeRelative(entry.file); const graphSource = join(folder, graphFile.replaceAll('/', sep));
      const graphTarget = join(site, graphFile.replaceAll('/', sep));
      if (graphFile.startsWith('remote/')) await install(graphSource, graphTarget); else die(`${member.dir}: entry file must be under remote/`);
      copied.set(graphFile, { path: graphTarget, bytes: (await lstat(graphSource)).size });
      entries.push({ ...entry, file: graphFile });
      const arts = instrumentReport.coverage;
      coverage[entry.id] = Object.fromEntries(Object.entries(arts).map(([articulation, value]) => [articulation, value.ranges]));
      for (const audio of member.audio) {
        if (!own(audio) || typeof audio.audioId !== 'string' || !/^audio-[a-f0-9]{64}$/.test(audio.audioId) || typeof audio.file !== 'string') die(`${member.dir}: invalid audio record`);
        const previous = audioById.get(audio.audioId);
        if (previous && JSON.stringify(previous) !== JSON.stringify(audio)) die(`audio ID metadata conflict: ${audio.audioId}`);
        audioById.set(audio.audioId, audio);
        const af = safeRelative(audio.file); if (!af.startsWith('remote/')) die(`${member.dir}: audio file must be under remote/`);
        const sourcePath = join(folder, af.replaceAll('/', sep)), targetPath = join(site, af.replaceAll('/', sep));
        if (!copied.has(af)) { await install(sourcePath, targetPath); copied.set(af, { path: targetPath, bytes: (await lstat(sourcePath)).size }); }
      }
      const sourceCopy = join(provenance, `${entry.id}.report.json`); await writeFile(sourceCopy, json(instrumentReport));
      if (instrumentReport.source) await writeFile(join(provenance, `${entry.id}.source.json`), json(instrumentReport.source));
    }
    entries.sort((a, b) => a.id.localeCompare(b.id));
    const index = { schema: 'momo.remote-sound-library/v1', libraryId: assembly.name.replace(/^MomoSoundForge-assets-/, ''), name: `VCSL ${assembly.base}`, entries, audio: [...audioById.values()].sort((a, b) => a.audioId.localeCompare(b.audioId)) };
    await writeFile(join(site, 'index.json'), json(index));
    await writeFile(join(site, 'validation-scope.json'), json({ schema: 'momo.library-validation-scope/v1', instruments: coverage }));
    const siteFiles = await files(site);
    const records = [];
    let total = 0;
    for (const file of siteFiles) {
      if (file.rel === 'snapshot-manifest.json') continue;
      const bytes = await readFile(file.path), sha256 = digest(bytes);
      records.push({ file: file.rel, bytes: bytes.length, sha256 }); total += bytes.length;
    }
    const snapshot = { schema: 'momo.library-snapshot/v1', files: records.sort((a, b) => a.file.localeCompare(b.file)) };
    const snapshotBytes = json(snapshot);
    if (total + snapshotBytes.length >= HARD_LIMIT) die(`${assembly.name} exceeds hard 1 GiB limit`);
    await writeFile(join(site, 'snapshot-manifest.json'), snapshotBytes);
    report.sites.push({ libraryId: index.libraryId, directory: assembly.name, instruments: entries.map(e => e.id), entries: entries.length, audio: index.audio.length, bytes: total + snapshotBytes.length });
  }
  await writeFile(join(output, 'assembly-report.json'), json(report));
  console.log(JSON.stringify(report, null, 2));
}

import { fileURLToPath } from 'node:url';
main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
