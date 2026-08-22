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
import { readdirSync, statSync, readFileSync, writeFileSync, existsSync } from "node:fs";
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

function fresh(source, sibling) {
  if (!existsSync(sibling)) return false;
  return statSync(sibling).mtimeMs >= statSync(source).mtimeMs;
}

if (!existsSync(root)) {
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
  const size = statSync(path).size;
  if (size < MIN_BYTES) continue;
  files += 1;
  raw += size;
  const body = readFileSync(path);
  const brPath = `${path}.br`;
  if (!fresh(path, brPath)) {
    writeFileSync(
      brPath,
      brotliCompressSync(body, {
        params: {
          [constants.BROTLI_PARAM_QUALITY]: 11,
          [constants.BROTLI_PARAM_SIZE_HINT]: size,
        },
      }),
    );
  }
  br += statSync(brPath).size;
  const gzPath = `${path}.gz`;
  if (!fresh(path, gzPath)) {
    writeFileSync(gzPath, gzipSync(body, { level: 9 }));
  }
  gz += statSync(gzPath).size;
}

const mb = (n) => `${(n / 1024 / 1024).toFixed(2)} MB`;
console.log(
  `precompress: ${files} files, ${mb(raw)} raw -> ${mb(br)} brotli, ${mb(gz)} gzip`,
);
