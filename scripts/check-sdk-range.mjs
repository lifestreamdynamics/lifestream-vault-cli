#!/usr/bin/env node
/**
 * Refuse to publish the CLI against an SDK range that can resolve to a version
 * older than the features the CLI actually calls.
 *
 * Why this exists: the monorepo resolves `@lifestreamdynamics/vault-sdk`
 * through a workspace symlink to `packages/sdk`, so every CLI test passes
 * against local source no matter what the published range says. In 2026-09 the
 * working tree held SDK 2.2.6 with `ifMatch` support while npm served a
 * *different* 2.2.6 without it, and the CLI's `^2.2.0` range resolved to the
 * published one for end users — turning every conditional write into an
 * unconditional one and silently reinstating the data-loss bug that commit
 * 08b56cc fixed. No test in this repo could have caught it.
 *
 * Bump MIN_SDK whenever the CLI starts calling a newly added SDK API.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Lowest SDK version that provides everything the CLI calls:
 *   2.3.0 — `DocumentWriteOptions.ifMatch` on documents.put AND documents.delete,
 *           exported `PreconditionFailedError`, `quoteEtag` bare-hash normalisation
 *   2.2.0 — `documents.syncList` / `SyncListKnownState`, `DocumentGetResult`
 */
const MIN_SDK = '2.3.0';
const SDK = '@lifestreamdynamics/vault-sdk';

const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
const range = pkg.dependencies?.[SDK];

if (!range) {
  console.error(`check-sdk-range: ${SDK} is not a dependency of ${pkg.name}.`);
  process.exit(1);
}

/**
 * Minimum version a range can resolve to. Deliberately narrow: this repo only
 * ever writes `^X.Y.Z`, `~X.Y.Z`, `>=X.Y.Z` or a bare `X.Y.Z`, and anything
 * else must fail loudly rather than be guessed at.
 */
function minVersionOf(spec) {
  const match = /^(?:\^|~|>=)?\s*(\d+)\.(\d+)\.(\d+)$/.exec(spec.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compare(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

const actual = minVersionOf(range);
const required = minVersionOf(MIN_SDK);

if (actual === null) {
  console.error(
    `check-sdk-range: cannot determine the minimum version of range "${range}".\n` +
    `  Use a plain ^X.Y.Z / ~X.Y.Z / >=X.Y.Z / X.Y.Z range so this check stays sound.`,
  );
  process.exit(1);
}

if (compare(actual, required) < 0) {
  console.error(
    `check-sdk-range: ${pkg.name} declares "${SDK}": "${range}", which can resolve to ` +
    `${actual.join('.')} — older than the ${MIN_SDK} this CLI requires.\n\n` +
    `  Publishing this would ship a CLI whose conditional writes silently become\n` +
    `  unconditional for end users, because npm would hand them an SDK without\n` +
    `  ifMatch support while the workspace symlink kept every local test green.\n\n` +
    `  Fix: publish SDK >= ${MIN_SDK}, then set the range to "^${MIN_SDK}".`,
  );
  process.exit(1);
}

console.log(`check-sdk-range: OK — "${range}" resolves no lower than ${MIN_SDK}.`);
