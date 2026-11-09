import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SOURCE_COMMIT = 'dfcf4a4918771eee884b96ad4493de82ef84daf6';
export const sha256 = b => createHash('sha256').update(b).digest('hex');
export const gitBlobId = b => createHash('sha1').update(`blob ${b.length}\0`).update(b).digest('hex');
export async function retryFetch(url) {
  for (let attempt = 0; ; attempt++) {
    let response;
    try {
      response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(90000) });
      if (response.ok) return new Uint8Array(await response.arrayBuffer());
      if (![408, 429, 500, 502, 503, 504].includes(response.status)) throw Object.assign(new Error(`HTTP ${response.status}: ${url}`), { fatal: true });
      await response.body?.cancel();
    } catch (error) {
      if (error.fatal || attempt >= 5) throw error;
    }
    if (attempt >= 5) throw Error(`HTTP ${response?.status}: ${url}`);
    await new Promise(r => setTimeout(r, Math.min(10000, 1000 * 2 ** attempt)));
  }
}
export async function fetchOriginal(item, cache) {
  const file = join(cache, item.sha + '.wav');
  let bytes;
  try { bytes = await readFile(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!bytes) {
    bytes = await retryFetch(`https://raw.githubusercontent.com/sgossner/VCSL/${SOURCE_COMMIT}/` + item.path.split('/').map(encodeURIComponent).join('/'));
    if (bytes.length !== item.size || gitBlobId(bytes) !== item.sha) throw Error(`Original Git blob mismatch: ${item.path}`);
    await writeFile(file + '.partial', bytes);
    await rename(file + '.partial', file);
  }
  if (bytes.length !== item.size || gitBlobId(bytes) !== item.sha) throw Error(`Cached original mismatch: ${item.path}`);
  return { ...item, sha256: sha256(bytes) };
}

async function main() {
  const args = new Map();
  for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1]);
  const cache = resolve(args.get('cache'));
  const lockFile = resolve(args.get('lock'));
  const lock = JSON.parse(await readFile(lockFile, 'utf8'));
  if (lock.commit !== SOURCE_COMMIT || !Array.isArray(lock.files)) throw Error('Invalid pinned source lock');
  await mkdir(cache, { recursive: true });
  let next = 0, done = 0, bytes = 0;
  const originals = [];
  await Promise.all(Array.from({ length: Number(args.get('concurrency') ?? 12) }, async () => {
    for (;;) {
      const item = lock.files[next++]; if (!item) return;
      const result = await fetchOriginal(item, cache);
      originals.push(result); bytes += result.size;
      if (++done % 100 === 0 || done === lock.files.length) console.log(`Verified originals ${done}/${lock.files.length}; ${(bytes / 1048576).toFixed(1)} MiB`);
    }
  }));
  originals.sort((a, b) => a.path.localeCompare(b.path, 'en'));
  await writeFile(join(cache, 'originals.json'), JSON.stringify({ commit: SOURCE_COMMIT, files: originals }, null, 2) + '\n');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
