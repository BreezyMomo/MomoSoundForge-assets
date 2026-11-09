import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { bakePrepared, decodeMsa, decodeWav, encodeMsa, loadPrepared, mixPrepared, prepareOriginal } from './vcsl-audio.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
function makeWav({ bits = 24, channels = [[-1, -0.5, 0, 0.5, 1]], sampleRate = 8000, encoding = 1 } = {}) {
  const frames = channels[0].length, block = channels.length * bits / 8, data = Buffer.alloc(frames * block);
  for (let frame = 0; frame < frames; frame++) for (let channel = 0; channel < channels.length; channel++) {
    const value = channels[channel][frame], offset = frame * block + channel * bits / 8;
    if (encoding === 3) data.writeFloatLE(value, offset);
    else if (bits === 16) data.writeInt16LE(Math.round(Math.max(-1, Math.min(1 - 1 / 32768, value)) * 32768), offset);
    else if (bits === 24) data.writeIntLE(Math.round(Math.max(-1, Math.min(1 - 1 / 8388608, value)) * 8388608), offset, 3);
    else data.writeInt32LE(Math.round(Math.max(-1, Math.min(1 - 1 / 2147483648, value)) * 2147483648), offset);
  }
  const fmt = Buffer.alloc(16); fmt.writeUInt16LE(encoding, 0); fmt.writeUInt16LE(channels.length, 2); fmt.writeUInt32LE(sampleRate, 4); fmt.writeUInt32LE(sampleRate * block, 8); fmt.writeUInt16LE(block, 12); fmt.writeUInt16LE(bits, 14);
  const body = Buffer.concat([Buffer.from('fmt '), Buffer.from([16, 0, 0, 0]), fmt, Buffer.from('data'), Buffer.from(Uint32Array.of(data.length).buffer), data]);
  const header = Buffer.alloc(12); header.write('RIFF', 0); header.writeUInt32LE(body.length + 4, 4); header.write('WAVE', 8);
  return Buffer.concat([header, body]);
}
function makeExtensibleWav() {
  const pcm = Buffer.alloc(4); pcm.writeInt16LE(1000, 0); pcm.writeInt16LE(-1000, 2);
  const fmt = Buffer.alloc(40); fmt.writeUInt16LE(0xfffe, 0); fmt.writeUInt16LE(1, 2); fmt.writeUInt32LE(8000, 4); fmt.writeUInt32LE(16000, 8); fmt.writeUInt16LE(2, 12); fmt.writeUInt16LE(16, 14); fmt.writeUInt16LE(22, 16); fmt.writeUInt16LE(16, 18); fmt.writeUInt32LE(0, 20); Buffer.from('0100000000001000800000aa00389b71', 'hex').copy(fmt, 24);
  const body = Buffer.concat([Buffer.from('fmt '), Buffer.from([40, 0, 0, 0]), fmt, Buffer.from('data'), Buffer.from(Uint32Array.of(pcm.length).buffer), pcm]);
  const header = Buffer.alloc(12); header.write('RIFF', 0); header.writeUInt32LE(body.length + 4, 4); header.write('WAVE', 8); return Buffer.concat([header, body]);
}

test('strict WAV decoder preserves 24-bit signed values, stereo and extensible PCM', () => {
  const wav = makeWav({ bits: 24, channels: [[-1, 0, 1], [0.25, -0.25, 0]] });
  const decoded = decodeWav(wav);
  assert.equal(decoded.frames, 3); assert.equal(decoded.channels.length, 2); assert.equal(decoded.channels[0][0], -1); assert.ok(Math.abs(decoded.channels[0][2] - 1) < 1e-6); assert.ok(Math.abs(decoded.channels[1][0] - 0.25) < 1e-6);
  const ext = decodeWav(makeExtensibleWav()); assert.equal(ext.channels.length, 1); assert.ok(ext.channels[0][0] > 0);
});

test('decoder rejects truncated, mismatched and nonfinite WAV data', () => {
  const wav = makeWav({ bits: 16 });
  assert.throws(() => decodeWav(wav.subarray(0, wav.length - 1)), /RIFF|Truncated/);
  const wrong = Buffer.from(wav); wrong.writeUInt32LE(wrong.length, 4); assert.throws(() => decodeWav(wrong), /RIFF length/);
  const float = makeWav({ bits: 32, encoding: 3, channels: [[NaN]] }); assert.throws(() => decodeWav(float), /Nonfinite/);
  assert.throws(() => decodeMsa(Buffer.from('MSA1')), /canonical PCM/);
});

test('MSA content identity is canonical and prepared cache survives reload', async () => {
  const root = await mkdtemp(join(tmpdir(), 'momo-vcsl-audio-'));
  try {
    const originalCache = join(root, 'originals'), pcmCache = join(root, 'pcm'); await import('node:fs/promises').then(fs => fs.mkdir(originalCache, { recursive: true }));
    const wav = makeWav({ bits: 24, channels: [[0, 0.25, -0.5, 0.75]] }), item = { path: 'test.wav', sha: hash(Buffer.concat([Buffer.from(`blob ${wav.length}\0`), wav])), size: wav.length };
    // Git blob IDs are SHA-1, avoiding dependence on any lock parser in this test.
    item.sha = createHash('sha1').update(`blob ${wav.length}\0`).update(wav).digest('hex'); await writeFile(join(originalCache, `${item.sha}.wav`), wav);
    const prepared = await prepareOriginal(item, { originalCache, pcmCache }); const loaded = await loadPrepared(prepared); assert.equal('audio-' + hash(loaded), prepared.audioId); assert.equal(prepared.stats.peak, 0.75);
    const again = await prepareOriginal(item, { originalCache, pcmCache }); assert.equal(again.audioId, prepared.audioId); assert.deepEqual(decodeMsa(loaded).channels[0], decodeMsa(await loadPrepared(again)).channels[0]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('baking applies offset, gain and release envelope without mutating source', async () => {
  const root = await mkdtemp(join(tmpdir(), 'momo-vcsl-bake-'));
  try {
    const source = { sampleRate: 8000, channels: [Float32Array.from([1, 1, 1, 1]) ] }; const raw = encodeMsa(source.sampleRate, source.channels); const packed = Buffer.from((await import('node:zlib')).gzipSync(raw)); const id = 'audio-' + hash(raw); const prepared = { audioId: id, reference: { audioId: id, sampleRate: 8000, channelCount: 1, frames: 4 }, file: join(root, `${id}.pcm.gz`), sha256: hash(packed), bytes: packed.length, decodedBytes: raw.length }; await writeFile(prepared.file, packed);
    const baked = await bakePrepared(prepared, { gainDb: 6, offset: 1, envelope: { attack: 0, decay: 0, sustain: 0.5 } }, root); const decoded = await import('./vcsl-audio.mjs').then(m => m.decodePrepared(baked)); assert.equal(decoded.frames, 3); assert.ok(decoded.channels[0][0] > 0.9 && decoded.channels[0][0] < 1.1); assert.ok(decoded.channels[0][2] <= decoded.channels[0][0]); assert.equal((await loadPrepared(prepared)).length, raw.length);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('mixing resamples, offsets and sums stereo layers to a common root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'momo-vcsl-mix-'));
  try {
    async function prepared(rate, values) { const raw = encodeMsa(rate, [Float32Array.from(values)]), id = 'audio-' + hash(raw), packed = (await import('node:zlib')).gzipSync(raw); const p = { audioId: id, reference: { audioId: id, sampleRate: rate, channelCount: 1, frames: values.length }, file: join(root, `${id}.pcm.gz`), sha256: hash(packed), bytes: packed.length, decodedBytes: raw.length }; await writeFile(p.file, packed); return p; }
    const a = await prepared(8000, [1, 1, 1, 1]), b = await prepared(16000, [0.5, 0.5, 0.5, 0.5]); const mixed = await mixPrepared([{ prepared: a, rootMidi: 60 }, { prepared: b, rootMidi: 60, sampleOffset: 1, gainDb: -6 }], 60, root); const result = await import('./vcsl-audio.mjs').then(m => m.decodePrepared(mixed)); assert.equal(result.sampleRate, 16000); assert.ok(result.frames >= 4); assert.ok(result.channels[0][0] > 0.9); assert.ok(result.channels[0][1] > 1.2);
  } finally { await rm(root, { recursive: true, force: true }); }
});
