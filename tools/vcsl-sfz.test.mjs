import { test } from 'node:test';
import assert from 'node:assert/strict';
import { convertSfz, parseSfz } from './vcsl-sfz.mjs';

const convert = (text, options = {}) => convertSfz(parseSfz(text, { path: 'Samples/Instrument.sfz' }), options);
const codes = converted => converted.warnings.map(w => w.code);

test('SFZ inheritance, comments and last-value semantics preserve authored values', () => {
  const parsed = parseSfz(`
    // Leading comment
    <global> ampeg_attack=0.004 ampeg_release=0.2
    <master> volume=-3
    <group> sw_label=Sustain tune=4
    <region> sample="Recordings/Some C#4.wav" lokey=c4 hikey=d4 pitch_keycenter=c4 offset=4 offset=7
    /* section-looking <region> sample=bad.wav */
    <group> sw_label=Staccato
    <region> sample=Recordings/Short C4.wav key=60
  `, { path: 'Collection/Test.sfz' });
  assert.equal(parsed.regions.length, 2);
  assert.equal(parsed.regions[0].opcodes.offset, '7');
  assert.equal(parsed.regions[1].opcodes.tune, undefined, 'new group must not inherit previous group');
  const out = convertSfz(parsed);
  assert.deepEqual(out.regions.map(r => [r.keyLow, r.keyHigh, r.rootMidi, r.tuneCents, r.gainDb]), [[60, 62, 60, 4, -3], [60, 60, 60, 0, -3]]);
  assert.equal(out.regions[0].samplePath, 'Collection/Recordings/Some C#4.wav');
  assert.ok(codes(out).includes('duplicate-opcode-last-wins'));
});

test('unsupported executable directives, opcodes and escaping paths fail explicitly', () => {
  assert.throws(() => parseSfz('#include "other.sfz"\n<region> sample=a.wav'), /preprocessor/);
  assert.throws(() => parseSfz('<region> sample=a.wav filter_type=lpf_2p'), /unsupported opcode/);
  assert.throws(() => parseSfz('<region> sample="unterminated'), /unterminated/);
  assert.throws(() => convert('<region> sample=../../outside.wav key=60'), /escapes source root/);
  assert.throws(() => convert('<region> sample=https://example.com/a.wav key=60'), /unsafe sample path/);
  assert.throws(() => convert('<region> sample=a.wav key=60 pitch_keytrack=50'), /key tracking/);
  assert.throws(() => convert('<region> sample=a.wav key=60 trigger=first'), /unsupported trigger/);
});

test('crossfades become explicit midpoint switches without losing velocity coverage', () => {
  const out = convert(`
    <group> ampeg_release=1
    <region> sample=soft.wav key=60 xfout_lovel=45 xfout_hivel=65
    <region> sample=medium.wav key=60 xfin_lovel=45 xfin_hivel=65 xfout_lovel=79 xfout_hivel=99
    <region> sample=loud.wav key=60 xfin_lovel=79 xfin_hivel=99
  `);
  assert.deepEqual(out.regions.map(r => [r.velocityLow, r.velocityHigh]), [[1, 55], [56, 89], [90, 127]]);
  assert.deepEqual(out.coverage.sustain, { ranges: [[60, 60]], velocityHoles: [] });
  assert.ok(codes(out).includes('velocity-crossfade-hard-switch'));
  assert.ok(out.regions.every(r => r.loop === undefined));
});

test('release boundaries split bindings while retaining release pitch, tuning, offset and gain', () => {
  const out = convert(`
    <group> trigger=attack ampeg_attack=0.004 ampeg_release=0.4
    <region> sample=main.wav pitch_keycenter=60 lokey=60 hikey=63 volume=30
    <group> trigger=release ampeg_attack=0.1 rt_decay=3
    <region> sample=release-low.wav pitch_keycenter=59 lokey=60 hikey=61 offset=12 tune=-7 volume=-65
    <region> sample=release-high.wav pitch_keycenter=64 lokey=62 hikey=63 offset=9 tune=4 volume=28
  `);
  assert.equal(out.regions.length, 2);
  const [low, high] = out.regions;
  assert.deepEqual([low.keyLow, low.keyHigh, high.keyLow, high.keyHigh], [60, 61, 62, 63]);
  assert.equal(low.bakeGainDb, 6);
  assert.deepEqual(low.releaseVoice, { rootMidi: 59, tuneCents: -7, gainDb: -60, offset: 12, decayDbPerSecond: 3 });
  assert.equal(low.releaseBakeGainDb, -5);
  assert.equal(high.releaseVoice.gainDb, 24);
  assert.equal(high.releaseBakeGainDb, 4);
  assert.deepEqual(low.releaseEnvelope, { attack: .1, decay: 0, sustain: 1 });
  assert.equal(out.consumedSamples.length, 3);
  assert.ok(codes(out).includes('baked-release-envelope'));
});

test('different attack and release RR periods form their real six-step composite sequence', () => {
  const attack = [1, 2].map(i => `<region> sample=a${i}.wav key=60 seq_length=2 seq_position=${i}`).join('\n');
  const release = [1, 2, 3].map(i => `<region> sample=r${i}.wav key=60 seq_length=3 seq_position=${i}`).join('\n');
  const out = convert(`<group> trigger=attack\n${attack}\n<group> trigger=release\n${release}`);
  assert.equal(out.regions.length, 6);
  assert.deepEqual(out.regions.map(r => [r.samplePath.split('/').at(-1), r.releaseSamplePath.split('/').at(-1)]), [
    ['a1.wav', 'r1.wav'], ['a2.wav', 'r2.wav'], ['a1.wav', 'r3.wav'],
    ['a2.wav', 'r1.wav'], ['a1.wav', 'r2.wav'], ['a2.wav', 'r3.wav'],
  ]);
  assert.deepEqual(out.regions.map(r => r.roundRobin), [0, 1, 2, 3, 4, 5]);
  assert.ok(out.regions.every(r => !r.mixLayers));
  assert.ok(codes(out).includes('composite-round-robin'));
  assert.throws(() => convert('<region> sample=a.wav key=60 seq_length=2 seq_position=1'), /silent authored round-robin/);
});

test('simultaneous voices become explicit mix instructions, never alternating takes', () => {
  const out = convert(`
    <group> trigger=attack sw_label=Full ampeg_attack=0.004 ampeg_release=0.4
    <region> sample=Low/main.wav lokey=60 hikey=61 pitch_keycenter=60 volume=-3 offset=12
    <region> sample=High/main.wav lokey=60 hikey=61 pitch_keycenter=72 volume=-5 offset=18 tune=4
    <group> trigger=release sw_label=Full
    <region> sample=Low/release.wav lokey=60 hikey=61 pitch_keycenter=60 volume=-6
    <region> sample=High/release.wav lokey=60 hikey=61 pitch_keycenter=72 volume=-9
  `);
  assert.equal(out.regions.length, 1);
  const r = out.regions[0];
  assert.equal(r.mixLayers.length, 2);
  assert.deepEqual(r.mixLayers[1], { samplePath: 'Samples/High/main.wav', rootMidi: 72, tuneCents: 4, gainDb: -5, bakeGainDb: 0, sampleOffset: 18 });
  assert.equal(r.releaseMixLayers.length, 2);
  assert.deepEqual(r.releaseMixLayers[0].envelope, { attack: 0, decay: 0, sustain: 1 });
  assert.deepEqual([r.gainDb, r.bakeGainDb, r.tuneCents, r.sampleOffset], [0, 0, 0, 0]);
  assert.deepEqual(r.envelope, { attack: .004, decay: 0, sustain: 1 });
  assert.deepEqual(r.releaseVoice, { rootMidi: 60, tuneCents: 0, gainDb: 0, offset: 0, decayDbPerSecond: 0 });
  assert.ok(codes(out).includes('baked-simultaneous-layers'));
  assert.throws(() => convert('<region> sample=a.wav key=60 ampeg_attack=0.1\n<region> sample=b.wav key=60 ampeg_attack=0.2'), /incompatible envelopes/);
});

test('CC64 states are static articulations, including real pedal-noise recordings', () => {
  const out = convert(`
    <group> trigger=attack locc64=65 hicc64=127
    <region> sample=on.wav key=60
    <group> trigger=attack locc64=0 hicc64=64
    <region> sample=off.wav key=60
    <group> trigger=release
    <region> sample=release.wav key=60
    <group> lokey=127 hikey=0 on_locc64=65 on_hicc64=127 pitch_keytrack=0 amp_veltrack=0
    <region> sample=pedal.wav
  `);
  assert.deepEqual(out.regions.map(r => r.articulation), ['sustain-pedal-on', 'sustain-pedal-off', 'pedal-down']);
  assert.deepEqual(out.regions.slice(0, 2).map(r => r.pedalState), ['on', 'off']);
  assert.ok(out.regions.slice(0, 2).every(r => r.releaseSamplePath === 'Samples/release.wav'));
  const pedal = out.regions[2];
  assert.deepEqual([pedal.rootMidi, pedal.keyLow, pedal.keyHigh, pedal.fixedPitch, pedal.playback], [60, 60, 60, true, 'one-shot']);
  assert.deepEqual(out.omittedControllerSamples, []);
  assert.ok(codes(out).includes('linear-velocity-response'));
});

test('sample remaps are source-relative and never silently lose release recordings', () => {
  const out = convert('<region> sample=Misplaced/a.wav key=60', { samplePathRemap: [{ from: 'Samples/Misplaced/', to: 'Samples/Actual/' }] });
  assert.equal(out.regions[0].samplePath, 'Samples/Actual/a.wav');
  assert.throws(() => convert('<region> sample=attack.wav key=60\n<group> trigger=release\n<region> sample=release.wav key=61'), /refusing to drop recordings/);
});

test('coverage distinguishes authored unused keys from missing velocities on supported keys', () => {
  const out = convert(`
    <region> sample=low.wav key=60 lovel=0 hivel=59
    <region> sample=high.wav key=60 lovel=61 hivel=127
    <region> sample=other.wav key=62
  `);
  assert.deepEqual(out.coverage.sustain, { ranges: [[60, 60], [62, 62]], velocityHoles: [{ midi: 60, velocity: 60 }] });
});

test('the converter enforces the existing instrument region budget', () => {
  const text = Array.from({ length: 513 }, (_, i) => `<group> sw_label=Art ${i}\n<region> sample=a.wav key=60`).join('\n');
  assert.throws(() => convert(text), /512-region instrument budget/);
});
