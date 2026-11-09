import { posix } from 'node:path';

const allowed = new Set([
  'sample', 'default_path', 'key', 'lokey', 'hikey', 'pitch_keycenter', 'pitch_keytrack',
  'lovel', 'hivel', 'volume', 'tune', 'offset', 'seq_length', 'seq_position',
  'sw_default', 'sw_lokey', 'sw_hikey', 'sw_last', 'sw_label', 'trigger',
  'ampeg_attack', 'ampeg_decay', 'ampeg_sustain', 'ampeg_release', 'amp_veltrack',
  'xfin_lovel', 'xfin_hivel', 'xfout_lovel', 'xfout_hivel',
  'locc64', 'hicc64', 'on_locc64', 'on_hicc64', 'rt_decay',
]);

const standardArticulations = new Map([
  ['sustain', 'sustain'], ['sus', 'sustain'], ['normal', 'sustain'], ['non-vibrato', 'sustain'],
  ['susvib', 'sustain-vibrato'], ['vib', 'sustain-vibrato'], ['vibrato', 'sustain-vibrato'],
  ['stac', 'staccato'], ['staccato', 'staccato'], ['spiccato', 'spiccato'],
  ['tremolo', 'tremolo'], ['pluck', 'pizzicato'], ['hit', 'single-hit'],
]);

function fail(path, message) {
  throw new Error(`${path || 'SFZ'}: ${message}`);
}

function removeComments(text, path) {
  let output = '', quote = '', block = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], next = text[i + 1];
    if (block) {
      if (c === '*' && next === '/') { block = false; output += '  '; i++; }
      else output += c === '\n' ? '\n' : ' ';
    } else if (quote) {
      output += c;
      if (c === quote) quote = '';
    } else if (c === '"') { quote = c; output += c; }
    else if (c === '/' && next === '*') { block = true; output += '  '; i++; }
    else if (c === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') { output += ' '; i++; }
      if (i < text.length) output += '\n';
    } else output += c;
  }
  if (block || quote) fail(path, 'unterminated comment or quoted value');
  return output;
}

/** Parse the deliberately restricted, data-only SFZ subset used by pinned VCSL. */
export function parseSfz(text, { path = '' } = {}) {
  if (typeof text !== 'string' || text.length > 8 * 1024 * 1024) fail(path, 'invalid SFZ text');
  const clean = removeComments(text.replace(/^\uFEFF/, ''), path);
  if (/^\s*#/m.test(clean)) fail(path, 'preprocessor directives are not supported');
  const headers = [...clean.matchAll(/<([^>]+)>/g)];
  if (!headers.length || clean.slice(0, headers[0].index).trim()) fail(path, 'expected a section header');
  let global = {}, master = {}, group = {}, control = {};
  const regions = [], warnings = [];
  for (let i = 0; i < headers.length; i++) {
    const header = headers[i], section = header[1].trim().toLowerCase();
    if (!['global', 'master', 'group', 'region', 'control'].includes(section)) fail(path, `unsupported section <${section}>`);
    const body = clean.slice(header.index + header[0].length, headers[i + 1]?.index ?? clean.length);
    const matches = [...body.matchAll(/(?:^|\s)([a-zA-Z][\w]*)\s*=/g)];
    if (matches.length && body.slice(0, matches[0].index).trim()) fail(path, 'unexpected text before opcode');
    if (!matches.length && body.trim()) fail(path, 'unexpected section text');
    const values = {};
    for (let j = 0; j < matches.length; j++) {
      const match = matches[j], opcode = match[1];
      if (!allowed.has(opcode)) fail(path, `unsupported opcode ${opcode}`);
      if (Object.hasOwn(values, opcode)) warnings.push({ code: 'duplicate-opcode-last-wins', message: `Repeated ${opcode} in <${section}> follows SFZ last-value semantics.`, section: i });
      let value = body.slice(match.index + match[0].length, matches[j + 1]?.index ?? body.length).trim();
      if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
      if (!value || /[<>\r\n]/.test(value)) fail(path, `invalid ${opcode} value`);
      values[opcode] = value;
    }
    if (section === 'control') {
      if (Object.keys(values).some(k => k !== 'default_path')) fail(path, 'control section only accepts default_path');
      control = { ...control, ...values };
    } else if (section === 'global') { global = values; master = {}; group = {}; }
    else if (section === 'master') { master = values; group = {}; }
    else if (section === 'group') group = values;
    else regions.push({ opcodes: { ...global, ...master, ...group, ...values }, sourceIndex: regions.length });
  }
  if (!regions.length) fail(path, 'no regions');
  return { path: path.replaceAll('\\', '/'), regions, warnings, defaultPath: control.default_path ?? '' };
}

function numeric(o, key, defaultValue, path, { integer = false, low = -Infinity, high = Infinity } = {}) {
  if (o[key] !== undefined && !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(o[key])) fail(path, `invalid ${key}: ${o[key]}`);
  const n = o[key] === undefined ? defaultValue : Number(o[key]);
  if (!Number.isFinite(n) || (integer && !Number.isInteger(n)) || n < low || n > high) fail(path, `invalid ${key}: ${o[key]}`);
  return n;
}

function midi(o, key, defaultValue, path) {
  if (o[key] === undefined) return defaultValue;
  const value = o[key];
  if (/^-?\d+$/.test(value)) return numeric(o, key, defaultValue, path, { integer: true, low: 0, high: 127 });
  const note = /^([a-g])([#b]?)(-?\d+)$/i.exec(value);
  if (!note) fail(path, `invalid ${key}: ${value}`);
  const n = (Number(note[3]) + 1) * 12 + { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 }[note[1].toLowerCase()] + (note[2] === '#' ? 1 : note[2] === 'b' ? -1 : 0);
  if (n < 0 || n > 127) fail(path, `out-of-range ${key}`);
  return n;
}

function samplePath(parsed, value, remap) {
  if (!value || value.startsWith('*') || value.includes('\0') || /^[/\\]|^[a-z]+:/i.test(value)) fail(parsed.path, `unsafe sample path ${value}`);
  const result = posix.normalize(posix.join(posix.dirname(parsed.path), parsed.defaultPath.replaceAll('\\', '/'), value.replaceAll('\\', '/')));
  if (result === '..' || result.startsWith('../')) fail(parsed.path, 'sample escapes source root');
  const prefix = Array.isArray(remap) ? remap.find(r => result.startsWith(r.from)) : undefined;
  const mapped = typeof remap === 'function' ? remap(result) : prefix ? prefix.to + result.slice(prefix.from.length) : remap?.[result] ?? result;
  if (typeof mapped !== 'string' || !mapped || mapped.startsWith('/') || mapped === '..' || mapped.startsWith('../') || mapped.includes('\\')) fail(parsed.path, 'unsafe remapped sample path');
  return mapped;
}

function gain(value) {
  const gainDb = Math.max(-60, Math.min(24, value));
  return { gainDb, bakeGainDb: value - gainDb };
}

function ranges(keys) {
  const output = [];
  for (const key of [...new Set(keys)].sort((a, b) => a - b)) {
    const last = output.at(-1);
    if (last && key === last[1] + 1) last[1] = key;
    else output.push([key, key]);
  }
  return output;
}

function articulationId(label) {
  return standardArticulations.get(label.toLowerCase()) ?? label.toLowerCase()
    .replaceAll("'", '-foot').replaceAll('+', '-and-').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

const gcd = (a, b) => b ? gcd(b, a % b) : a;
const lcm = (a, b) => a * b / gcd(a, b);

function audioLayer(region) {
  return Object.fromEntries(['samplePath', 'rootMidi', 'tuneCents', 'gainDb', 'bakeGainDb', 'sampleOffset'].map(k => [k, region[k]]));
}

function mixAttack(layers, path) {
  const first = layers[0];
  if (layers.length === 1) return { ...first };
  if (layers.some(r => JSON.stringify(r.envelope) !== JSON.stringify(first.envelope) || r.releaseSeconds !== first.releaseSeconds || !!r.fixedPitch !== !!first.fixedPitch || r.playback !== first.playback)) fail(path, 'simultaneous attack layers have incompatible envelopes, note-off or pitch tracking');
  return { ...first, mixLayers: layers.map(audioLayer), rootMidi: first.rootMidi,
    gainDb: 0, bakeGainDb: 0, tuneCents: 0, sampleOffset: 0 };
}

function attachRelease(region, layers, path, warn) {
  if (!layers.length) return region;
  const first = layers[0];
  if (layers.some(r => r._releaseDecay !== first._releaseDecay || !!r.fixedPitch !== !!first.fixedPitch)) fail(path, 'simultaneous release layers have incompatible decay or pitch tracking');
  if (first.fixedPitch) fail(path, 'fixed-pitch release voices cannot be represented by the engine');
  if (layers.some(r => r.envelope.attack !== 0 || r.envelope.decay !== 0 || r.envelope.sustain !== 1)) warn('baked-release-envelope', 'Release attack/decay/sustain must be baked after the authored source offset; the original source and mapping remain retained. The engine also applies its short source-edge taper.');
  if (layers.length === 1) return { ...region, releaseSamplePath: first.samplePath, releaseBakeGainDb: first.bakeGainDb,
    releaseEnvelope: { ...first.envelope },
    releaseVoice: { rootMidi: first.rootMidi, tuneCents: first.tuneCents, gainDb: first.gainDb, offset: first.sampleOffset, decayDbPerSecond: first._releaseDecay } };
  warn('baked-simultaneous-layers', 'Simultaneous SFZ voices are mixed into a new full-length floating-point recording, preserving relative pitch, offset and gain; these are layered voices, not round-robin alternates.');
  return { ...region, releaseSamplePath: first.samplePath, releaseBakeGainDb: 0, releaseMixLayers: layers.map(r => ({ ...audioLayer(r), envelope: { ...r.envelope } })),
    releaseVoice: { rootMidi: region.rootMidi, tuneCents: 0, gainDb: 0, offset: 0, decayDbPerSecond: first._releaseDecay } };
}

/**
 * Convert one SFZ into editable mapping data. Auxiliary samplePath/bakeGainDb
 * fields must be resolved to real assets by the packer before sealing.
 * Author crossfades become documented midpoint switches; no loop is invented.
 */
export function convertSfz(parsed, options = {}) {
  const warnings = [...(parsed.warnings ?? [])], labels = {}, consumedSamples = new Set();
  const addWarning = (code, message, sourceIndex) => {
    if (!warnings.some(w => w.code === code && w.message === message)) warnings.push({ code, message, ...(sourceIndex === undefined ? {} : { sourceIndex }) });
  };
  const entries = parsed.regions.map(({ opcodes: o, sourceIndex }) => {
    const at = `${parsed.path}/region-${sourceIndex + 1}`;
    if (!o.sample) fail(at, 'missing sample');
    const controller = o.on_locc64 !== undefined || o.on_hicc64 !== undefined;
    const pedalLow = numeric(o, controller ? 'on_locc64' : 'locc64', 0, at, { integer: true, low: 0, high: 127 });
    const pedalHigh = numeric(o, controller ? 'on_hicc64' : 'hicc64', 127, at, { integer: true, low: 0, high: 127 });
    if (pedalLow > pedalHigh) fail(at, 'reversed controller range');
    const pedal = pedalLow >= 65 ? 'on' : pedalHigh <= 64 ? 'off' : 'any';
    if (pedal === 'any' && (pedalLow !== 0 || pedalHigh !== 127)) fail(at, 'CC64 range cannot be represented by binary static pedal articulation');
    let label = controller ? `Pedal ${pedal === 'on' ? 'down' : 'up'}` : o.sw_label ?? options.articulation ?? 'sustain';
    const renamed = options.articulationNames?.[label];
    const mapped = typeof renamed === 'string' ? renamed : renamed?.id;
    let articulation = mapped ?? articulationId(label);
    const baseArticulation = articulation;
    if (!controller && pedal !== 'any') { articulation += `-pedal-${pedal}`; label += ` (pedal ${pedal})`; }
    if (typeof articulation !== 'string' || !articulation.trim() || articulation.length > 60) fail(at, 'invalid articulation');
    labels[articulation] = typeof renamed === 'object' ? { ...renamed, source: label } : { en: label };
    if (controller) addWarning('controller-as-notes', 'CC64 pedal noises are exposed as separate fixed-pitch Pedal down/up articulations on MIDI 60; automatic MIDI controller triggering is unavailable.');
    else if (pedal !== 'any') addWarning('static-pedal-articulations', 'CC64 sustain-pedal states are selectable static articulations; mid-note controller changes are unavailable.');
    let keyLow = midi(o, 'lokey', o.key === undefined ? 0 : midi(o, 'key', 60, at), at);
    let keyHigh = midi(o, 'hikey', o.key === undefined ? 127 : midi(o, 'key', 60, at), at);
    let rootMidi = midi(o, 'pitch_keycenter', o.key === undefined ? 60 : midi(o, 'key', 60, at), at);
    if (controller) keyLow = keyHigh = rootMidi = 60;
    if (keyLow > keyHigh) fail(at, 'reversed key range');
    let velocityLow = Math.max(1, numeric(o, 'lovel', 0, at, { integer: true, low: 0, high: 127 }));
    let velocityHigh = numeric(o, 'hivel', 127, at, { integer: true, low: 0, high: 127 });
    if (o.xfin_lovel !== undefined || o.xfin_hivel !== undefined) {
      const low = numeric(o, 'xfin_lovel', 0, at, { integer: true, low: 0, high: 127 });
      const high = numeric(o, 'xfin_hivel', 127, at, { integer: true, low: 0, high: 127 });
      if (low > high) fail(at, 'reversed fade-in range');
      velocityLow = Math.max(velocityLow, Math.floor((low + high) / 2) + 1);
      addWarning('velocity-crossfade-hard-switch', 'Velocity crossfades are approximated by deterministic switches at each authored crossfade midpoint; overlapping SFZ layers are not mixed.');
    }
    if (o.xfout_lovel !== undefined || o.xfout_hivel !== undefined) {
      const low = numeric(o, 'xfout_lovel', 0, at, { integer: true, low: 0, high: 127 });
      const high = numeric(o, 'xfout_hivel', 127, at, { integer: true, low: 0, high: 127 });
      if (low > high) fail(at, 'reversed fade-out range');
      velocityHigh = Math.min(velocityHigh, Math.floor((low + high) / 2));
      addWarning('velocity-crossfade-hard-switch', 'Velocity crossfades are approximated by deterministic switches at each authored crossfade midpoint; overlapping SFZ layers are not mixed.');
    }
    if (velocityLow > velocityHigh) fail(at, 'empty velocity range after crossfade conversion');
    const seqLength = numeric(o, 'seq_length', 1, at, { integer: true, low: 1, high: 128 });
    const seqPosition = numeric(o, 'seq_position', 1, at, { integer: true, low: 1, high: seqLength });
    const keyTrack = numeric(o, 'pitch_keytrack', 100, at);
    if (![0, 100].includes(keyTrack)) fail(at, 'only fixed pitch and chromatic key tracking are supported');
    const velTrack = numeric(o, 'amp_veltrack', 100, at);
    if (velTrack !== 100) addWarning('linear-velocity-response', `Author amp_veltrack=${velTrack} is adapted to the engine's linear note-velocity gain; timbre layers and authored relative sample volumes are retained.`);
    const trigger = o.trigger ?? 'attack';
    if (!['attack', 'release'].includes(trigger)) fail(at, `unsupported trigger ${trigger}`);
    const sample = samplePath(parsed, o.sample, options.samplePathRemap);
    consumedSamples.add(sample);
    const authoredGain = numeric(o, 'volume', 0, at), gains = gain(authoredGain);
    if (gains.bakeGainDb) addWarning('baked-gain', 'Volume outside the engine region gain range must be baked into the corresponding floating-point sample, with the remainder kept as region gain.');
    const attack = numeric(o, 'ampeg_attack', 0, at, { low: 0, high: 30 });
    const decay = numeric(o, 'ampeg_decay', 0, at, { low: 0, high: 100 });
    const sustain = numeric(o, 'ampeg_sustain', 100, at, { low: 0, high: 100 }) / 100;
    const releaseSeconds = Math.max(.005, numeric(o, 'ampeg_release', .001, at, { low: 0, high: 30 }));
    if (o.ampeg_release === undefined || Number(o.ampeg_release) < .005) addWarning('minimum-release', 'Release shorter than 5 ms is adapted to the engine minimum of 5 ms.');
    return {
      sourceIndex, samplePath: sample, rootMidi, keyLow, keyHigh, velocityLow, velocityHigh,
      articulation, roundRobin: seqPosition - 1, tuneCents: numeric(o, 'tune', 0, at, { low: -1200, high: 1200 }),
      gainDb: gains.gainDb, bakeGainDb: gains.bakeGainDb, releaseSeconds,
      sampleOffset: numeric(o, 'offset', 0, at, { integer: true, low: 0 }),
      envelope: { attack, decay, sustain },
      ...(keyTrack === 0 || controller ? { fixedPitch: true } : {}),
      ...(controller ? { playback: 'one-shot' } : {}),
      _trigger: controller ? 'attack' : trigger, _pedal: pedal, _controller: controller,
      _baseArticulation: baseArticulation,
      pedalState: pedal,
      _seqLength: seqLength, _seqPosition: seqPosition,
      _releaseDecay: numeric(o, 'rt_decay', 0, at, { low: 0, high: 200 }),
    };
  });
  const attacks = entries.filter(r => r._trigger === 'attack'), releases = entries.filter(r => r._trigger === 'release');
  if (!attacks.length) fail(parsed.path, 'no attack regions');
  let regions = [];
  const usedReleases = new Set();
  for (const articulation of new Set(attacks.map(r => r.articulation))) {
    const artAttacks = attacks.filter(r => r.articulation === articulation), first = artAttacks[0];
    const artReleases = releases.filter(r => r._baseArticulation === first._baseArticulation && (r._pedal === first._pedal || r._pedal === 'any'));
    const all = [...artAttacks, ...artReleases];
    const keyCuts = [...new Set(all.flatMap(r => [r.keyLow, r.keyHigh + 1]))].sort((a, b) => a - b);
    const velocityCuts = [...new Set(all.flatMap(r => [r.velocityLow, r.velocityHigh + 1]))].sort((a, b) => a - b);
    for (let k = 0; k < keyCuts.length - 1; k++) for (let v = 0; v < velocityCuts.length - 1; v++) {
      const keyLow = keyCuts[k], keyHigh = keyCuts[k + 1] - 1, velocityLow = velocityCuts[v], velocityHigh = velocityCuts[v + 1] - 1;
      const covers = r => keyLow >= r.keyLow && keyHigh <= r.keyHigh && velocityLow >= r.velocityLow && velocityHigh <= r.velocityHigh;
      const localAttacks = artAttacks.filter(covers), localReleases = artReleases.filter(covers);
      if (!localAttacks.length) continue;
      const cycle = [...localAttacks, ...localReleases].reduce((n, r) => lcm(n, r._seqLength), 1);
      if (cycle > 128) fail(parsed.path, 'combined attack/release round-robin cycle exceeds 128');
      if (new Set([...localAttacks, ...localReleases].map(r => r._seqLength)).size > 1) addWarning('composite-round-robin', 'Independent attack/release round-robin cycles are represented by their least-common-multiple sequence, reusing attack bindings without inventing new recordings.');
      for (let sequence = 0; sequence < cycle; sequence++) {
        const activeAttacks = localAttacks.filter(r => sequence % r._seqLength === r._seqPosition - 1);
        const activeReleases = localReleases.filter(r => sequence % r._seqLength === r._seqPosition - 1);
        if (!activeAttacks.length) fail(parsed.path, `silent authored round-robin position at MIDI ${keyLow}, velocity ${velocityLow}, ${articulation}, sequence ${sequence + 1}`);
        let region = mixAttack(activeAttacks, parsed.path);
        if (activeAttacks.length > 1) addWarning('baked-simultaneous-layers', 'Simultaneous SFZ voices are mixed into a new full-length floating-point recording, preserving relative pitch, offset and gain; these are layered voices, not round-robin alternates.');
        region = attachRelease(region, activeReleases, parsed.path, addWarning);
        activeReleases.forEach(r => usedReleases.add(r.sourceIndex));
        regions.push({ ...region, keyLow, keyHigh, velocityLow, velocityHigh, roundRobin: sequence });
      }
    }
  }
  const unmatchedReleases = releases.filter(r => !usedReleases.has(r.sourceIndex));
  if (unmatchedReleases.length) fail(parsed.path, `${unmatchedReleases.length} release regions do not match an attack; refusing to drop recordings: ${JSON.stringify(unmatchedReleases.slice(0,3).map(r=>({path:r.samplePath,key:[r.keyLow,r.keyHigh],vel:[r.velocityLow,r.velocityHigh],rr:r.roundRobin})))}`);
  // The rectangular partition above may introduce redundant boundaries from a
  // neighbouring key's velocity map. Join only truly identical adjacent cells.
  const same = (a, b, omit) => JSON.stringify(Object.fromEntries(Object.entries(a).filter(([k]) => !omit.includes(k)))) === JSON.stringify(Object.fromEntries(Object.entries(b).filter(([k]) => !omit.includes(k))));
  for (const [lo, hi] of [['velocityLow', 'velocityHigh'], ['keyLow', 'keyHigh']]) {
    const merged = [];
    for (const r of regions) {
      const prior = merged.find(p => p[hi] + 1 === r[lo] && same(p, r, [lo, hi]));
      if (prior) prior[hi] = r[hi]; else merged.push(r);
    }
    regions = merged;
  }
  if (regions.length > 512) fail(parsed.path, `${regions.length} converted regions exceed the 512-region instrument budget`);
  for (const region of regions) {
    delete region._trigger; delete region._pedal; delete region._controller;
    delete region._baseArticulation;
    delete region._seqLength; delete region._seqPosition; delete region._releaseDecay;
  }
  // Explicit grouping retains the author's RR relationship after release splits.
  for (const region of regions) {
    const peers = regions.filter(r => r.articulation === region.articulation && r.keyLow === region.keyLow && r.keyHigh === region.keyHigh && r.velocityLow === region.velocityLow && r.velocityHigh === region.velocityHigh);
    if (peers.some(r => r.rootMidi !== region.rootMidi) && peers.length > 1) region.playbackGroup = `vcsl-${region.articulation}-${region.keyLow}-${region.keyHigh}-${region.velocityLow}-${region.velocityHigh}`;
  }
  regions.forEach((r, i) => { r.id = `region-${i + 1}`; });
  const coverage = {};
  for (const articulation of new Set(regions.map(r => r.articulation))) {
    const rs = regions.filter(r => r.articulation === articulation), keys = [];
    for (const r of rs) for (let key = r.keyLow; key <= r.keyHigh; key++) keys.push(key);
    const holes = [];
    for (const key of new Set(keys)) for (let velocity = 1; velocity <= 127; velocity++) if (!rs.some(r => key >= r.keyLow && key <= r.keyHigh && velocity >= r.velocityLow && velocity <= r.velocityHigh)) holes.push({ midi: key, velocity });
    coverage[articulation] = { ranges: ranges(keys), velocityHoles: holes };
  }
  return { regions, warnings, labels, coverage,
    keyRange: { low: Math.min(...regions.map(r => r.keyLow)), high: Math.max(...regions.map(r => r.keyHigh)) },
    consumedSamples: [...consumedSamples], omittedControllerSamples: [],
  };
}
