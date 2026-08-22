#!/usr/bin/env node
/**
 * Write .br and .gz siblings for every static asset under web-next/.
 *
 * The server serves these with `precompressed: true` (src/app.ts). Compressing
 * at build time rather than per request means the highest brotli quality costs
 * nothing at runtime, and the loopback server does no compression work at all.
 *
 * Idempotent: a sibling newer than its source is left alone, so a rerun after
 * an unchanged build is free.
 */
import { readdirSync, statSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, gzipSync, constants } from "node:zlib";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "web-next");

/** Text formats only. Re-compressing png/woff2 makes them bigger. */
const COMPRESSIBLE = /\.(js|mjs|css|html|json|svg|txt|map|xml|ico)$/i;
/** Below this the header overhead outweighs anything saved. */
const MIN_BYTES = 1024;

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (entry.isFile()) yield path;
  }
}

/**
 * `mtimeMs`, or null when the path is not there.
 *
 * A try/catch rather than an `existsSync` guard: between the check and the use
 * the file can be gone, and a build step racing a rebuild is exactly where that
 * happens.
 */
function mtimeOf(path) {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

/** True when `sibling` is present and no older than `sourceMtime`. */
function fresh(sourceMtime, sibling) {
  const at = mtimeOf(sibling);
  return at !== null && at >= sourceMtime;
}

if (mtimeOf(root) === null) {
  console.log("precompress: web-next/ not built yet, nothing to do");
  process.exit(0);
}

let files = 0;
let raw = 0;
let br = 0;
let gz = 0;
for (const path of walk(root)) {
  if (/\.(br|gz)$/i.test(path)) continue;
  if (!COMPRESSIBLE.test(path)) continue;
  // Read first and measure the bytes in hand. Sizing with a separate stat and
  // then reading leaves a window where the two disagree, and the numbers below
  // would be reporting a file that is no longer the one that was compressed.
  let body;
  let sourceMtime;
  try {
    body = readFileSync(path);
    sourceMtime = statSync(path).mtimeMs;
  } catch {
    // Vanished mid-walk. Nothing to compress, and nothing worth failing over.
    continue;
  }
  if (body.length < MIN_BYTES) continue;
  files += 1;
  raw += body.length;

  const brPath = `${path}.br`;
  if (fresh(sourceMtime, brPath)) {
    br += readFileSync(brPath).length;
  } else {
    const compressed = brotliCompressSync(body, {
      params: {
        [constants.BROTLI_PARAM_QUALITY]: 11,
        [constants.BROTLI_PARAM_SIZE_HINT]: body.length,
      },
    });
    writeFileSync(brPath, compressed);
    br += compressed.length;
  }

  const gzPath = `${path}.gz`;
  if (fresh(sourceMtime, gzPath)) {
    gz += readFileSync(gzPath).length;
  } else {
    const compressed = gzipSync(body, { level: 9 });
    writeFileSync(gzPath, compressed);
    gz += compressed.length;
  }
}

const mb = (n) => `${(n / 1024 / 1024).toFixed(2)} MB`;
console.log(
  `precompress: ${files} files, ${mb(raw)} raw -> ${mb(br)} brotli, ${mb(gz)} gzip`,
);
