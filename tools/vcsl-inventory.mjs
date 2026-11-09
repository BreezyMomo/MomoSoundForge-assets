import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

// Publisher input only. No instrument catalog is copied into the application.
export const SOURCE_COMMIT = 'dfcf4a4918771eee884b96ad4493de82ef84daf6';
const translations = Object.fromEntries(`
Ball Whistle|球哨
Baroque Alto Recorder|巴洛克中音竖笛
Baroque Bass Recorder|巴洛克低音竖笛
Baroque Soprano Recorder|巴洛克高音竖笛
Baroque Tenor Recorder|巴洛克次中音竖笛
Ocarina, Small|小陶笛
Ocarina, Typical|标准陶笛
Pipe Organ|管风琴
Renaissance Organ|文艺复兴风琴
Train Whistle, Toy|玩具火车哨
Harmonica-Hohner-Special20-C|霍纳 Special 20 口琴（C 调）
Harmonica-Hohner-Special20-F|霍纳 Special 20 口琴（F 调）
Harmonica-Hohner-Super64|霍纳 Super 64 半音阶口琴
Siren|警笛
Didgeridoo|迪吉里杜管
Saxello|萨克塞罗管
Tenor Saxophone|次中音萨克斯管
Concert Harp|竖琴
Folk Harp|民谣竖琴
Strumstick|Strumstick 三弦琴
Dan Tranh|越南筝
Grand Piano, Kawai|卡瓦依大钢琴
Grand Piano, Steinway B|施坦威 B 型大钢琴
Harpsichord, English|英式羽管键琴
Harpsichord, Flemish|佛兰德羽管键琴
Harpsichord, French|法式羽管键琴
Harpsichord, Italian|意式羽管键琴
Harpsichord, Unk|羽管键琴（型号未注明）
Psaltery, Bowed and Plucked|弓奏与拨奏诗琴
Upright Piano, Knight|Knight 立式钢琴
Upright Piano, Yamaha|雅马哈立式钢琴
TX81Z|雅马哈 TX81Z 合成音色
Wine Glasses|摩擦酒杯
Kalimba, Kenya|肯尼亚卡林巴拇指琴
Kalimba, Tanzania|坦桑尼亚卡林巴拇指琴
Mbira Mavembe (Gandanga), Zimbabwe, Low G|津巴布韦 Mavembe 姆比拉琴（低 G 调）
Mbira dzaVadzimu Nyamaropa, Zimbabwe, Low B|津巴布韦 dzaVadzimu 姆比拉琴（低 B 调）
Nyunga Nyunga, Mozambique, Low F|莫桑比克 Nyunga Nyunga 拇指琴（低 F 调）
Agogo Bells|阿戈戈双音铃
Anvil|铁砧
Balafon|巴拉风木琴
Bell Tree|钟铃树
Brake Drum|制动鼓打击器
Cabasa|卡巴萨沙铃
Cajon|箱鼓
Claps|拍手
Clash Cymbals 1|碰钹 1
Clash Cymbals 2|碰钹 2
Claves|击棒
Cowbells|牛铃
Finger Cymbals|指钹
Flexatone|弹性金属片琴
Glockenspiel|钟琴
Gong 1|锣 1
Gong 2|锣 2
Guiro|刮瓜
Hand Bells, Nepalese|尼泊尔手铃
Hand Chimes|手摇音管铃
Hi-Hat Cymbal|踩镲
Marimba|马林巴
Mark Trees|风铃树
Ratchet|棘轮响器
Shaker|沙锤（早期款）
Shaker, Large|大沙锤
Shaker, Small|小沙锤
Slapstick|拍板
Sleigh Bells|雪橇铃
Slit Drum|裂缝鼓
Suspended Cymbal 1|悬吊镲 1
Suspended Cymbal 2|悬吊镲 2
Tambourine 1|铃鼓 1
Tambourine 2|铃鼓 2
Tambourine 3|铃鼓 3
Tambourine 4|铃鼓 4
Tambourine 5|铃鼓 5
Triangles|三角铁
Tubular Bells 1|管钟 1
Tubular Bells 2|管钟 2
Tubular Bells 3|管钟 3
Tubular Glockenspiel|管式钟琴
Vibraphone|颤音琴
Vibraslap|颤响器
Woodblock|木鱼
Xylophone|木琴
Ocean Drum|海浪鼓
Bass Drum 1|大鼓 1
Bass Drum 2|大鼓 2
Bass Drum 3|大鼓 3
Bongos|邦戈鼓
Conga|康加鼓
Darbuka|达布卡鼓
Frame Drum|框鼓
Legacy Snares|早期小军鼓组
Legacy Toms|早期通鼓组
Snare Drum, Modern 1|现代小军鼓 1
Snare Drum, Modern 2|现代小军鼓 2
Snare Drum, Modern 3|现代小军鼓 3
Snare Drum, Rope Tension|绳张力小军鼓
Timpani 1|定音鼓 1
Timpani 2|定音鼓 2
Tom 1|通鼓 1
Tom 2|通鼓 2
`.trim().split('\n').map(line => line.split('|')));

const existing = {
  'Grand Piano, Kawai': 'instrument-vcsl-kawai',
  'Concert Harp': 'instrument-vcsl-concert-harp',
  'Tenor Saxophone': 'instrument-vcsl-tenor-saxophone',
};
const slug = value => value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const melodicPercussion = new Set(['Wine Glasses', 'Balafon', 'Glockenspiel', 'Hand Chimes', 'Marimba', 'Tubular Bells 1', 'Tubular Bells 2', 'Tubular Bells 3', 'Tubular Glockenspiel', 'Vibraphone', 'Xylophone']);
const englishNames = {
  'Grand Piano, Kawai': 'Kawai Grand Piano',
  'Grand Piano, Steinway B': 'Steinway B Grand Piano',
  'Harpsichord, Unk': 'Harpsichord (Unspecified Model)',
  'TX81Z': 'Yamaha TX81Z',
};

export function inventory(sfzs, mappingChecks, tree, official) {
  const checked = new Map(mappingChecks.map(row => [row.path, row]));
  const blobs = new Map(tree.filter(row => row.type === 'blob').map(row => [row.path, row]));
  const groups = new Map();
  for (const row of sfzs) {
    const name = row.path.split('/').at(-1).replace(/\.sfz$/i, '').split(' - ')[0];
    const key = row.path.slice(0, row.path.lastIndexOf('/') + 1) + name;
    const group = groups.get(key) ?? { key, name, maps: [] };
    group.maps.push(row);
    groups.set(key, group);
  }
  const replacementNames = {
    'Concert Harp': ['Harp'], 'Timpani 1': ['Timpani'], 'Glockenspiel': ['Glockenspiel'],
    'Marimba': ['Marimba'], 'Xylophone': ['Xylophone'], 'Bass Drum 1': ['Bass drum'],
    'Snare Drum, Modern 1': ['Snare drum'], 'Clash Cymbals 1': ['Crash cymbal'],
    'Triangles': ['Triangle'], 'Tambourine 1': ['Tambourine'],
    'Grand Piano, Kawai': ['builtin.instrument.vcsl-kawai'],
  };
  const instruments = [...groups.values()].sort((a, b) => a.key.localeCompare(b.key, 'en')).map(group => {
    if (!translations[group.name]) throw Error(`Missing translation: ${group.name}`);
    const selected = group.maps.find(row => row.path.endsWith(' - Keyswitch.sfz'))
      ?? group.maps.find(row => row.path === group.key + '.sfz')
      ?? (group.maps.length === 1 ? group.maps[0] : undefined);
    if (!selected) throw Error(`Ambiguous map selection: ${group.name}`);
    const allSamples = new Set(group.maps.flatMap(row => checked.get(row.path).samples));
    const samples = new Set(checked.get(selected.path).samples);
    // The modern Kawai deliberately supersedes its duplicate legacy mapping.
    if (group.name !== 'Grand Piano, Kawai' && [...allSamples].some(sample => !samples.has(sample))) throw Error(`Selected map loses samples: ${group.name}`);
    const category = group.key.startsWith('Aerophones/')
      ? /Organ$/.test(group.name) ? 'keys' : 'woodwinds'
      : group.key.startsWith('Chordophones/')
        ? /Piano|Harpsichord/.test(group.name) ? 'keys' : 'strings'
        : group.key.startsWith('Electrophones/') ? 'keys' : 'percussion';
    const batch = category === 'percussion' ? '01-percussion' : category === 'keys' ? '03-keyboards' : '02-winds-and-plucked';
    const suggestedLibrary = group.name.startsWith('Timpani') ? 'vcsl-timpani'
      : melodicPercussion.has(group.name) ? 'vcsl-mallets'
      : category === 'percussion' ? 'vcsl-percussion'
      : category === 'woodwinds' ? 'vcsl-winds'
      : category === 'strings' ? 'vcsl-plucked'
      : group.name === 'Grand Piano, Steinway B' ? 'vcsl-piano-steinway'
      : group.name === 'Upright Piano, Knight' ? 'vcsl-piano-knight'
      : group.name === 'Upright Piano, Yamaha' ? 'vcsl-piano-yamaha'
      : group.name.startsWith('Harpsichord') ? 'vcsl-harpsichords' : 'vcsl-keyboards';
    const remap = group.name === 'Psaltery, Bowed and Plucked' ? [{
      from: 'Chordophones/Zithers/Psaltery, Bowed and Plucked/',
      to: 'Chordophones/Zithers/Harpsichord, Italian/Psaltery, Bowed and Plucked/',
    }] : [];
    const physical = sample => {
      for (const rule of remap) if (sample.startsWith(rule.from)) return rule.to + sample.slice(rule.from.length);
      return sample;
    };
    for (const sample of samples) if (!blobs.has(physical(sample))) throw Error(`Missing source sample: ${physical(sample)}`);
    const replaceRecordingEntryIds = official.entries.filter(entry => entry.kind === 'recording'
      && (replacementNames[group.name] ?? []).includes((entry.names?.en ?? entry.name).split(' · ')[0])).map(entry => entry.id);
    return {
      id: existing[group.name] ?? 'instrument-vcsl-' + slug(group.name),
      sourceKey: group.key,
      names: { zh: translations[group.name], en: englishNames[group.name] ?? group.name },
      category, batch, suggestedLibrary,
      sfz: [selected.path],
      sourceMappings: group.maps.map(row => ({ path: row.path, gitBlob: blobs.get(row.path).sha,
        sha256: createHash('sha256').update(row.text).digest('hex'), selected: row === selected })),
      ...(existing[group.name] ? { existing: true } : {}),
      ...(remap.length ? { samplePathRemap: remap } : {}),
      ...(replaceRecordingEntryIds.length ? { replaceRecordingEntryIds } : {}),
      sampleCount: samples.size,
      sourceBytes: [...samples].reduce((sum, sample) => sum + blobs.get(physical(sample)).size, 0),
      ...(group.name === 'Grand Piano, Kawai' ? { notes: ['Keep the published modern complete Kawai definition; the Legacy mapping is not imported as another copy.'] } : {}),
      ...(remap.length ? { notes: ['Repair only the SFZ relative path using the same pinned snapshot; do not fetch samples from another branch.'] } : {}),
    };
  });
  return {
    schema: 'momo.vcsl-source-plan/v1',
    createdAt: '2026-11-09',
    source: { repository: 'https://github.com/sgossner/VCSL', branch: 'sfz', commit: SOURCE_COMMIT,
      license: 'CC0-1.0', licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
      licenseEvidence: `https://github.com/sgossner/VCSL/blob/${SOURCE_COMMIT}/README.md` },
    limits: { plannedLibraryBytes: 850 * 1024 * 1024, maximumLibraryBytes: 1024 * 1024 * 1024,
      maximumPackageBytes: 768 * 1024 * 1024, maximumExpandedPackageBytes: 1536 * 1024 * 1024 },
    removalPolicy: 'Remove listed recording catalog entries only after the corresponding complete instrument is published and validated. Retain immutable files and dependencies. Never modify existing user projects.',
    instruments,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = new Map();
  for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1]);
  const prefix = args.get('evidence-prefix');
  const output = args.get('output');
  if (!prefix || !output) throw Error('Pass --evidence-prefix PREFIX --output MANIFEST_JSON');
  const load = async suffix => JSON.parse(await readFile(`${prefix}-${suffix}.json`, 'utf8'));
  const [sfzs, checks, tree, official] = await Promise.all(['sfz', 'mapping-check', 'tree', 'official'].map(load));
  const result = inventory(sfzs, checks, tree.tree, official);
  await mkdir(dirname(resolve(output)), { recursive: true });
  await writeFile(output, JSON.stringify(result, null, 2) + '\n');
  console.log(`Wrote ${result.instruments.length} complete-instrument source records to ${output}`);
}
