#!/usr/bin/env node
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import decodeEncoded from 'audio-decode';

export const MAX_FRAMES = 5_760_000;
export const MAX_PCM_BYTES = 16 + MAX_FRAMES * 8;
const VERSION = 'momo.vcsl-pcm/v1';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const gitBlobId = bytes => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
const finite = (value, label) => { if (!Number.isFinite(value)) throw Error(`Invalid ${label}`); return value; };
function buffer(bytes) { return Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength); }
function dimensions(sampleRate, channelCount, frames) {
  if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 192000 || ![1, 2].includes(channelCount)
    || !Number.isInteger(frames) || frames < 1 || frames > MAX_FRAMES) throw Error('PCM dimensions exceed protocol budget');
}

/** Decode RIFF PCM without resampling, normalization or dropping any frames. */
export function decodeWav(bytes) {
  const wav = buffer(bytes);
  if (wav.length < 44 || wav.length > 64 * 1024 * 1024 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') throw Error('Expected a bounded RIFF/WAVE recording');
  if (wav.readUInt32LE(4) + 8 !== wav.length) throw Error('RIFF length mismatch or truncated WAV');
  let format, data;
  for (let cursor = 12; cursor < wav.length;) {
    if (cursor + 8 > wav.length) throw Error('Truncated WAV chunk header');
    const tag = wav.toString('ascii', cursor, cursor + 4), length = wav.readUInt32LE(cursor + 4), start = cursor + 8;
    // Some VCSL files omit the optional terminal pad byte after an odd-sized
    // data chunk. Accept that exact EOF form while still rejecting truncation
    // in every non-terminal chunk.
    if (start + length > wav.length || (start + length < wav.length && start + length + (length % 2) > wav.length)) throw Error('Truncated WAV chunk data');
    if (tag === 'fmt ') {
      if (format || length < 16) throw Error('Missing or duplicate WAV format');
      let encoding = wav.readUInt16LE(start);
      const channelCount = wav.readUInt16LE(start + 2), sampleRate = wav.readUInt32LE(start + 4), byteRate = wav.readUInt32LE(start + 8);
      const blockAlign = wav.readUInt16LE(start + 12), bits = wav.readUInt16LE(start + 14);
      let validBits = bits;
      if (encoding === 0xfffe) {
        if (length < 40 || wav.readUInt16LE(start + 16) < 22 || wav.readUInt16LE(start + 16) + 18 > length) throw Error('Invalid extensible WAV format');
        validBits = wav.readUInt16LE(start + 18);
        const guid = wav.subarray(start + 24, start + 40).toString('hex');
        if (!['0100000000001000800000aa00389b71', '0300000000001000800000aa00389b71'].includes(guid)) throw Error('Unsupported extensible WAV codec');
        encoding = wav.readUInt32LE(start + 24);
      }
      if (!((encoding === 1 && [16, 24, 32].includes(bits)) || (encoding === 3 && bits === 32))
        || validBits < 1 || validBits > bits || (encoding === 3 && validBits !== 32)
        || blockAlign !== channelCount * bits / 8 || byteRate !== sampleRate * blockAlign) throw Error('Unsupported or inconsistent WAV PCM format');
      format = { encoding, channelCount, sampleRate, bits, validBits, blockAlign };
    } else if (tag === 'data') {
      if (data) throw Error('Duplicate WAV data chunk');
      data = wav.subarray(start, start + length);
      // A few VCSL Clavisynth files contain an unlabelled INFO tail after a
      // complete data chunk. The PCM payload is fully bounded and verified;
      // ignore only that trailing metadata, never truncated audio data.
      break;
    }
    cursor = start + length + (start + length < wav.length ? length % 2 : 0);
  }
  if (!format || !data || !data.length || data.length % format.blockAlign) throw Error('Missing or misaligned WAV audio data');
  const { encoding, channelCount, sampleRate, bits, blockAlign } = format, frames = data.length / blockAlign;
  dimensions(sampleRate, channelCount, frames);
  const channels = Array.from({ length: channelCount }, () => new Float32Array(frames));
  for (let frame = 0; frame < frames; frame++) for (let channel = 0; channel < channelCount; channel++) {
    const offset = frame * blockAlign + channel * bits / 8;
    const value = encoding === 3 ? data.readFloatLE(offset) : bits === 16 ? data.readInt16LE(offset) / 32768
      : bits === 24 ? data.readIntLE(offset, 3) / 8388608 : data.readInt32LE(offset) / 2147483648;
    if (!Number.isFinite(value)) throw Error(`Nonfinite WAV sample at frame ${frame}, channel ${channel}`);
    channels[channel][frame] = value;
  }
  return { sampleRate, channels, frames, sourceEncoding: encoding === 3 ? 'float' : 'integer', sourceBits: bits, validBits: format.validBits };
}

/** Decode the small number of legacy VCSL sources that are published as MP3/OGG.
 * WAV remains on the strict decoder above; compressed sources are decoded once
 * to canonical float PCM and retain their original Git blob provenance. */
async function decodeOriginal(bytes, path) {
  if (/\.wav$/i.test(path)) return decodeWav(bytes);
  if (!/\.(?:mp3|ogg|oga|opus)$/i.test(path)) throw Error(`Unsupported encoded source format: ${path}`);
  const decoded = await decodeEncoded(bytes);
  if (!decoded || !Number.isInteger(decoded.sampleRate) || !Array.isArray(decoded.channelData) || !decoded.channelData.length) throw Error(`Encoded source has no PCM channels: ${path}`);
  const channels = decoded.channelData.map(channel => channel instanceof Float32Array ? channel : Float32Array.from(channel));
  const frames = channels[0]?.length;
  if (!channels.every(channel => channel.length === frames)) throw Error(`Encoded source has mismatched channels: ${path}`);
  dimensions(decoded.sampleRate, channels.length, frames);
  return { sampleRate: decoded.sampleRate, channels, frames, sourceEncoding: path.toLowerCase().endsWith('.mp3') ? 'mp3' : 'ogg', sourceBits: 32, validBits: 32 };
}

export function encodeMsa(sampleRate, channels) {
  const frames = channels[0]?.length;
  dimensions(sampleRate, channels.length, frames);
  const bytes = Buffer.allocUnsafe(16 + frames * channels.length * 4);
  bytes.write('MSA1', 0, 'ascii'); bytes.writeUInt32LE(sampleRate, 4); bytes.writeUInt32LE(channels.length, 8); bytes.writeUInt32LE(frames, 12);
  for (let channel = 0; channel < channels.length; channel++) {
    if (!(channels[channel] instanceof Float32Array) || channels[channel].length !== frames) throw Error('Mismatched PCM channels');
    for (let frame = 0; frame < frames; frame++) {
      const value = channels[channel][frame];
      if (!Number.isFinite(value)) throw Error('Nonfinite canonical PCM sample');
      bytes.writeFloatLE(value, 16 + (channel * frames + frame) * 4);
    }
  }
  return bytes;
}

export function decodeMsa(raw) {
  const bytes = buffer(raw);
  if (bytes.length < 20 || bytes.length > MAX_PCM_BYTES || bytes.toString('ascii', 0, 4) !== 'MSA1') throw Error('Invalid canonical PCM header');
  const sampleRate = bytes.readUInt32LE(4), channelCount = bytes.readUInt32LE(8), frames = bytes.readUInt32LE(12);
  dimensions(sampleRate, channelCount, frames);
  if (bytes.length !== 16 + frames * channelCount * 4) throw Error('Canonical PCM length mismatch');
  const channels = Array.from({ length: channelCount }, () => new Float32Array(frames));
  for (let channel = 0; channel < channelCount; channel++) for (let frame = 0; frame < frames; frame++) {
    const value = bytes.readFloatLE(16 + (channel * frames + frame) * 4);
    if (!Number.isFinite(value)) throw Error('Nonfinite canonical PCM sample');
    channels[channel][frame] = value;
  }
  return { sampleRate, channels, frames };
}

export function audioStats(sampleRate, channels) {
  const frames = channels[0].length, tailStart = Math.max(0, frames - Math.round(sampleRate * 0.25)), activeThreshold = 0.00001;
  const perChannel = channels.map(channel => {
    let peak = 0, sum = 0, square = 0, clipCount = 0, nonZeroSamples = 0, activeSamples = 0, firstActiveFrame = null, lastActiveFrame = null, tailPeak = 0, tailSquare = 0;
    for (let i = 0; i < frames; i++) {
      const value = finite(channel[i], 'PCM sample'), magnitude = Math.abs(value);
      peak = Math.max(peak, magnitude); sum += value; square += value * value;
      if (magnitude >= 1) clipCount++;
      if (value !== 0) nonZeroSamples++;
      if (magnitude >= activeThreshold) { activeSamples++; firstActiveFrame ??= i; lastActiveFrame = i; }
      if (i >= tailStart) { tailPeak = Math.max(tailPeak, magnitude); tailSquare += value * value; }
    }
    return { peak, rms: Math.sqrt(square / frames), dc: sum / frames, clipCount, nonZeroSamples, activeSamples,
      firstActiveFrame, lastActiveFrame, trailingQuietSeconds: (frames - 1 - (lastActiveFrame ?? -1)) / sampleRate,
      tailPeak, tailRms: Math.sqrt(tailSquare / (frames - tailStart)) };
  });
  return { sampleRate, channelCount: channels.length, frames, durationSeconds: frames / sampleRate, activeThreshold,
    peak: Math.max(...perChannel.map(x => x.peak)), rms: Math.sqrt(perChannel.reduce((sum, x) => sum + x.rms ** 2, 0) / channels.length),
    dc: perChannel.reduce((sum, x) => sum + x.dc, 0) / channels.length,
    clipCount: perChannel.reduce((sum, x) => sum + x.clipCount, 0), nonZeroSamples: perChannel.reduce((sum, x) => sum + x.nonZeroSamples, 0),
    activeSamples: perChannel.reduce((sum, x) => sum + x.activeSamples, 0), channels: perChannel };
}

async function atomicWrite(file, bytes) {
  const temporary = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.partial`;
  await writeFile(temporary, bytes);
  await rename(temporary, file);
}
async function persist(sampleRate, channels, cacheDirectory, provenance = {}) {
  const cache = resolve(cacheDirectory);
  await mkdir(cache, { recursive: true });
  const raw = encodeMsa(sampleRate, channels), audioId = 'audio-' + sha256(raw), file = join(cache, `${audioId}.pcm.gz`);
  let packed;
  try {
    packed = await readFile(file);
    if (sha256(gunzipSync(packed, { maxOutputLength: MAX_PCM_BYTES })) !== audioId.slice(6)) throw Error('Existing PCM cache identity mismatch');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    packed = gzipSync(raw, { level: 6 });
    await atomicWrite(file, packed);
  }
  const reference = { schema: 'momo.audio-reference/v1', audioId, sampleRate, channelCount: channels.length, frames: channels[0].length };
  return { ...provenance, audioId, reference, file, sha256: sha256(packed), bytes: packed.length, decodedBytes: raw.length, stats: audioStats(sampleRate, channels) };
}

export async function loadPrepared(prepared) {
  if (!/^audio-[a-f0-9]{64}$/.test(prepared.audioId) || !/^[a-f0-9]{64}$/.test(prepared.sha256)) throw Error('Invalid prepared PCM descriptor');
  const packed = await readFile(prepared.file);
  if (packed.length !== prepared.bytes || sha256(packed) !== prepared.sha256) throw Error('Prepared PCM transport mismatch');
  const raw = gunzipSync(packed, { maxOutputLength: MAX_PCM_BYTES });
  if (raw.length !== prepared.decodedBytes || 'audio-' + sha256(raw) !== prepared.audioId || prepared.reference?.audioId !== prepared.audioId) throw Error('Prepared PCM content identity mismatch');
  const decoded = decodeMsa(raw);
  if (decoded.sampleRate !== prepared.reference.sampleRate || decoded.channels.length !== prepared.reference.channelCount || decoded.frames !== prepared.reference.frames) throw Error('Prepared PCM reference dimensions mismatch');
  return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
}
export async function decodePrepared(prepared) { return decodeMsa(await loadPrepared(prepared)); }

export async function prepareOriginal(item, { originalCache, pcmCache }) {
  if (!item || !/^[a-f0-9]{40}$/.test(item.sha) || !Number.isSafeInteger(item.size) || item.size < 44 || typeof item.path !== 'string') throw Error('Invalid original source lock item');
  const original = await readFile(join(resolve(originalCache), item.sha + '.wav'));
  if (original.length !== item.size || gitBlobId(original) !== item.sha) throw Error(`Original Git blob mismatch: ${item.path}`);
  const originalSha256 = sha256(original), metadataFile = join(resolve(pcmCache), item.sha + '.prepared-v1.json');
  try {
    const cached = JSON.parse(await readFile(metadataFile, 'utf8'));
    if (cached.schema !== VERSION || cached.originalSha256 !== originalSha256 || cached.sha !== item.sha) throw Error('Prepared original metadata mismatch');
    await loadPrepared(cached);
    return { ...cached, sourcePath: item.path };
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const decoded = await decodeOriginal(original, item.path);
  const prepared = await persist(decoded.sampleRate, decoded.channels, pcmCache, { schema: VERSION, sourcePath: item.path, sha: item.sha, originalSha256,
    conversion: { kind: 'lossless-pcm-to-float32', sourceEncoding: decoded.sourceEncoding, sourceBits: decoded.sourceBits, validBits: decoded.validBits, normalization: false, resampling: false, trimmed: false } });
  await atomicWrite(metadataFile, JSON.stringify(prepared, null, 2) + '\n');
  return prepared;
}

function envelopeGain(envelope, seconds) {
  if (!envelope) return 1;
  const { attack = 0, decay = 0, sustain = 1 } = envelope;
  if (![attack, decay, sustain].every(Number.isFinite) || attack < 0 || attack > 30 || decay < 0 || decay > 100 || sustain < 0 || sustain > 1) throw Error('Invalid sample envelope');
  const rising = attack === 0 ? 1 : Math.min(1, seconds / attack);
  const falling = seconds < attack ? 1 : decay > 0 ? Math.max(sustain, 1 - (1 - sustain) * (seconds - attack) / decay) : sustain;
  return rising * falling;
}
function offsetFrames(offset, frames) {
  if (!Number.isInteger(offset) || offset < 0 || offset >= frames) throw Error('Sample offset outside full recording');
  return offset;
}
function linear(channel, position) {
  if (position < 0 || position > channel.length - 1) return 0;
  if (position === channel.length - 1) return channel[channel.length - 1];
  const index = Math.floor(position), fraction = position - index;
  return channel[index] * (1 - fraction) + channel[index + 1] * fraction;
}

export async function bakePrepared(source, { gainDb = 0, offset = 0, envelope } = {}, cacheDirectory) {
  finite(gainDb, 'gain');
  if (Math.abs(gainDb) > 240) throw Error('Bake gain exceeds bounded conversion range');
  if (gainDb === 0 && offset === 0 && !envelope) return source;
  const decoded = await decodePrepared(source), first = offsetFrames(offset, decoded.frames), gain = 10 ** (gainDb / 20);
  envelopeGain(envelope, 0);
  const channels = decoded.channels.map(channel => {
    const result = new Float32Array(decoded.frames - first);
    for (let frame = 0; frame < result.length; frame++) result[frame] = channel[frame + first] * gain * envelopeGain(envelope, frame / decoded.sampleRate);
    return result;
  });
  return persist(decoded.sampleRate, channels, cacheDirectory, { schema: VERSION, sourcePath: source.sourcePath, sha: source.sha, originalSha256: source.originalSha256,
    conversion: { kind: 'baked-sample-parameters', parentAudioId: source.audioId, gainDb, offset, ...(envelope ? { envelope } : {}), resampling: false } });
}

/** Sum real SFZ register layers at a common root using the engine's interpolation. */
export async function mixPrepared(layers, targetRootMidi, cacheDirectory) {
  if (!Array.isArray(layers) || !layers.length || layers.length > 32 || !Number.isInteger(targetRootMidi) || targetRootMidi < 0 || targetRootMidi > 127) throw Error('Invalid mix layers or root pitch');
  const decoded = [];
  for (const layer of layers) {
    const audio = await decodePrepared(layer.prepared);
    if (!Number.isInteger(layer.rootMidi) || layer.rootMidi < 0 || layer.rootMidi > 127) throw Error('Invalid layer root pitch');
    const tuneCents = finite(layer.tuneCents ?? 0, 'layer tuning'), gainDb = finite((layer.gainDb ?? 0) + (layer.bakeGainDb ?? 0), 'layer gain');
    if (Math.abs(tuneCents) > 1200 || Math.abs(gainDb) > 240) throw Error('Layer tuning or gain outside bounded conversion range');
    const offset = offsetFrames(layer.sampleOffset ?? layer.offset ?? 0, audio.frames);
    envelopeGain(layer.envelope, 0);
    decoded.push({ ...audio, layer, offset, tuneCents, gainDb });
  }
  const sampleRate = Math.max(...decoded.map(item => item.sampleRate)), channelCount = Math.max(...decoded.map(item => item.channels.length));
  let frames = 0;
  for (const item of decoded) {
    item.step = item.sampleRate / sampleRate * 2 ** ((targetRootMidi - item.layer.rootMidi + item.tuneCents / 100) / 12);
    item.length = Math.ceil((item.frames - item.offset) / item.step);
    frames = Math.max(frames, item.length);
  }
  dimensions(sampleRate, channelCount, frames);
  const channels = Array.from({ length: channelCount }, () => new Float32Array(frames));
  for (const item of decoded) {
    const gain = 10 ** (item.gainDb / 20);
    for (let frame = 0; frame < item.length; frame++) {
      const position = item.offset + frame * item.step, amplitude = gain * envelopeGain(item.layer.envelope, frame / sampleRate);
      for (let channel = 0; channel < channelCount; channel++) channels[channel][frame] += linear(item.channels[channel] ?? item.channels[0], position) * amplitude;
    }
  }
  return persist(sampleRate, channels, cacheDirectory, { schema: VERSION, sourcePath: layers.map(layer => layer.prepared.sourcePath).join(' + '),
    conversion: { kind: 'sfz-layer-mix', targetRootMidi, interpolation: 'engine-linear', outputSampleRate: sampleRate, guardFrames: 1,
      layers: layers.map(({ prepared, ...parameters }) => ({ audioId: prepared.audioId, sourcePath: prepared.sourcePath, ...parameters })) } });
}

async function main() {
  const args = new Map();
  for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1]);
  if (!args.get('lock') || !args.get('original-cache') || !args.get('cache')) throw Error('Pass --lock SOURCE_LOCK --original-cache ORIGINALS --cache PCM_CACHE [--shard 0 --shards 4]');
  const shard = Number(args.get('shard') ?? 0), shards = Number(args.get('shards') ?? 1);
  if (!Number.isInteger(shards) || shards < 1 || shards > 32 || !Number.isInteger(shard) || shard < 0 || shard >= shards) throw Error('Shards are zero-indexed and must be bounded');
  const lock = JSON.parse(await readFile(args.get('lock'), 'utf8'));
  if (lock.schema !== 'momo.vcsl-originals/v1' || !Array.isArray(lock.files)) throw Error('Invalid VCSL source lock');
  const cache = resolve(args.get('cache')), files = [], pending = [], unsupported = [], failures = [];
  await mkdir(cache, { recursive: true });
  const assigned = lock.files.filter((_, index) => index % shards === shard);
  for (const item of assigned) {
    try { files.push(await prepareOriginal(item, { originalCache: args.get('original-cache'), pcmCache: cache })); }
    catch (error) {
      if (error.code === 'ENOENT') pending.push(item.path);
      else if (!/\.wav$/i.test(item.path) && /Expected a bounded RIFF\/WAVE/.test(error.message)) unsupported.push({ path: item.path, error: error.message });
      else { failures.push({ path: item.path, error: error.message }); console.error(`${item.path}: ${error.message}`); }
    }
    if ((files.length + failures.length + pending.length) % 50 === 0) console.log(`Shard ${shard}/${shards}: ${files.length} prepared, ${pending.length} pending, ${failures.length} failed / ${assigned.length}`);
  }
  const manifest = { schema: 'momo.vcsl-prepared/v1', sourceCommit: lock.commit, shard, shards, files, pending, unsupported, failures };
  const manifestFile = resolve(args.get('manifest') ?? join(cache, `prepared-shard-${shard}-of-${shards}.json`));
  await atomicWrite(manifestFile, JSON.stringify(manifest, null, 2) + '\n');
  console.log(JSON.stringify({ manifest: manifestFile, prepared: files.length, pending: pending.length, unsupported: unsupported.length, failures: failures.length, assigned: assigned.length }));
  if (failures.length) process.exitCode = 1;
  else if (pending.length && args.get('allow-partial') !== 'true') process.exitCode = 2;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
