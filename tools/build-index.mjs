#!/usr/bin/env node
/*
 * build-index.mjs — validator and index generator for a Silica script catalog.
 *
 *   node tools/build-index.mjs --check    validate only; prints every problem, exits 1 if any
 *   node tools/build-index.mjs --write    validate, then write index.json
 *
 * Node 20+, standard library only. No dependencies, ever — this script is the whole toolchain.
 *
 * ---------------------------------------------------------------------------------------------
 * THE FOLDER DIGEST — a cross-language contract. Do not "tidy" this.
 *
 * An entry's identity is one hash over all of its installable files, so that a multi-file app is
 * one thing to compare rather than five. The Silica mod computes the same digest in Java over
 * what is on disk, and the two must agree byte for byte. The definition:
 *
 *   1. Take the entry's installable files — everything under scripts/<id>/ EXCEPT the entry-root
 *      silica.json and the entry-root README.md, which are catalog metadata, not content. (A
 *      README nested deeper, e.g. ui/README.md, IS app content and IS included.)
 *   2. For each, form the line:   <entry-relative path> 0x00 <lowercase hex sha256 of the file> 0x0A
 *      The path uses forward slashes. The separator is a single NUL byte. Every line ends with a
 *      single 0x0A — including the last one. There is no other whitespace and no trailing text.
 *   3. Sort the lines ascending by the entry-relative path, compared as unsigned UTF-8 bytes.
 *      (Java: Comparator.comparing(p -> p.getBytes(UTF_8), Arrays::compareUnsigned).)
 *   4. Concatenate them in that order and take SHA-256. The digest is the lowercase hex of that.
 *
 * An entry with no installable files digests to the SHA-256 of the empty input. That is a legal
 * value, not a special case — but the structural rules below reject such an entry anyway.
 * ---------------------------------------------------------------------------------------------
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------- limits and vocabulary
// These mirror the mod's [store] defaults. Keeping them a little stricter than the mod is fine;
// looser is not, because the mod would then refuse an entry CI called valid.
const MAX_FILE_BYTES = 262144;   // one installable file  ([store] maxFileBytes)
const MAX_ENTRY_FILES = 64;      // installable files in one entry  ([store] maxEntryFiles)
const MAX_PATH_CHARS = 160;      // an entry-relative path
const MAX_PATH_SEGMENTS = 6;     // slash-separated segments in an entry-relative path
const MAX_SUMMARY_CHARS = 160;

const ID_RE = /^[a-z0-9-]{1,48}$/;

const KINDS = ['script', 'app'];
const CATEGORIES = [
  'starter', 'example', 'redstone', 'storage', 'energy',
  'security', 'automation', 'monitoring', 'mining', 'other',
];
// Silica's capability doors, in the order the Store displays them. The first five are the
// script-facing faculties gated by computer parts; `web` is added by the optional web-display jar
// (it is a real capability with no server-side switch); the last seven are per-peripheral gates,
// each settled by the phase that added its block. Keep in sync with Config.java's [capabilities].
const DOORS = [
  'redstone', 'gfx', 'fs', 'network', 'pads', 'web',
  'detector', 'ejector', 'turret', 'spawn', 'security', 'geo', 'multidimensional',
];
const PARTS = ['gpu', 'hdd', 'nic'];

const CATALOG_VERSION = 1;
const CATALOG_NAME = 'Silica Store';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCRIPTS_DIR = join(ROOT, 'scripts');
const INDEX_PATH = join(ROOT, 'index.json');

// ------------------------------------------------------------------------------------------ helpers

/** Ascending, unsigned-UTF-8-byte order. The digest and files[] both depend on this exact order. */
function comparePaths(a, b) {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

function sha256Hex(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/** See the header comment. files: [{ path, sha256 }] in any order. */
function folderDigest(files) {
  const lines = [...files]
    .sort((a, b) => comparePaths(a.path, b.path))
    .map((f) => `${f.path}\0${f.sha256}\n`);
  return sha256Hex(Buffer.from(lines.join(''), 'utf8'));
}

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

function isStringArray(v) {
  return Array.isArray(v) && v.every((s) => typeof s === 'string');
}

/** Structural problems with one entry-relative path, as clause fragments. */
function pathProblems(rel) {
  const out = [];
  if (rel.length > MAX_PATH_CHARS) {
    out.push(`is ${rel.length} characters, over the ${MAX_PATH_CHARS}-character limit`);
  }
  const segs = rel.split('/');
  if (segs.length > MAX_PATH_SEGMENTS) {
    out.push(`has ${segs.length} path segments, over the limit of ${MAX_PATH_SEGMENTS}`);
  }
  if (segs.includes('..')) out.push('contains a ".." segment');
  if (segs.includes('.')) out.push('contains a "." segment');
  if (segs.includes('')) out.push('contains an empty path segment (a leading or doubled "/")');
  return out;
}

// -------------------------------------------------------------------------------------- the walk

/**
 * Collect every file under one entry folder. Pushes a problem for anything that is not a plain
 * file or directory, and never follows a symlink — it reports it instead.
 */
function walkEntry(absDir, relPrefix, id, files, problems) {
  let dirents;
  try {
    dirents = readdirSync(absDir, { withFileTypes: true });
  } catch (err) {
    problems.push(`scripts/${id}/${relPrefix}: cannot be read — ${err.message}`);
    return;
  }
  for (const d of dirents.sort((a, b) => comparePaths(a.name, b.name))) {
    const rel = relPrefix ? `${relPrefix}/${d.name}` : d.name;
    const shown = `scripts/${id}/${rel}`;

    if (d.isSymbolicLink()) {
      problems.push(`${shown}: is a symlink — symlinks are not allowed in a catalog`);
      continue;
    }
    if (d.name.startsWith('.')) {
      problems.push(`${shown}: dotfiles and dot-directories are not allowed`);
      continue;
    }
    for (const why of pathProblems(rel)) problems.push(`${shown}: path ${why}`);

    if (d.isDirectory()) {
      walkEntry(join(absDir, d.name), rel, id, files, problems);
      continue;
    }
    if (!d.isFile()) {
      problems.push(`${shown}: is not a regular file`);
      continue;
    }

    const abs = join(absDir, d.name);
    const bytes = statSync(abs).size;
    if (bytes > MAX_FILE_BYTES) {
      problems.push(`${shown}: is ${bytes} bytes, over the ${MAX_FILE_BYTES}-byte per-file limit`);
    }
    files.push({ path: rel, abs, bytes });
  }
}

// ------------------------------------------------------------------------------ entry validation

/** Validate one entry folder. Returns its index record, or null if it could not be built. */
function readEntry(id, problems) {
  const absEntry = join(SCRIPTS_DIR, id);
  const before = problems.length;

  if (!ID_RE.test(id)) {
    problems.push(`scripts/${id}: folder name must match ${ID_RE.source}`);
  }

  // 1 — the two required files.
  const all = [];
  walkEntry(absEntry, '', id, all, problems);
  const rootNames = new Set(all.filter((f) => !f.path.includes('/')).map((f) => f.path));
  for (const required of ['silica.json', 'README.md']) {
    if (!rootNames.has(required)) {
      problems.push(`scripts/${id}: required file ${required} is missing`);
    }
  }

  // 2 — the manifest.
  let man = null;
  if (rootNames.has('silica.json')) {
    const raw = readFileSync(join(absEntry, 'silica.json'), 'utf8');
    try {
      man = JSON.parse(raw);
    } catch (err) {
      problems.push(`scripts/${id}/silica.json: is not valid JSON — ${err.message}`);
    }
    if (man !== null && (typeof man !== 'object' || Array.isArray(man))) {
      problems.push(`scripts/${id}/silica.json: must be a JSON object`);
      man = null;
    }
  }

  if (man) {
    const where = `scripts/${id}/silica.json`;
    if (man.id !== id) {
      problems.push(`${where}: "id" is ${JSON.stringify(man.id)} but the folder is named "${id}" — they must match`);
    } else if (!ID_RE.test(man.id)) {
      problems.push(`${where}: "id" must match ${ID_RE.source}`);
    }
    for (const field of ['title', 'summary', 'kind', 'category', 'author']) {
      if (!isNonEmptyString(man[field])) {
        problems.push(`${where}: "${field}" is required and must be a non-empty string`);
      }
    }
    if (typeof man.summary === 'string') {
      if (man.summary.length > MAX_SUMMARY_CHARS) {
        problems.push(`${where}: "summary" is ${man.summary.length} characters, over the ${MAX_SUMMARY_CHARS}-character limit`);
      }
      if (/[\r\n]/.test(man.summary)) {
        problems.push(`${where}: "summary" must be a single line`);
      }
    }
    if (isNonEmptyString(man.kind) && !KINDS.includes(man.kind)) {
      problems.push(`${where}: "kind" is ${JSON.stringify(man.kind)}; must be one of ${KINDS.join(', ')}`);
    }
    if (isNonEmptyString(man.category) && !CATEGORIES.includes(man.category)) {
      problems.push(`${where}: "category" is ${JSON.stringify(man.category)}; must be one of ${CATEGORIES.join(', ')}`);
    }
    if (man.minSilica !== undefined && !isNonEmptyString(man.minSilica)) {
      problems.push(`${where}: "minSilica" is optional, but must be a non-empty string when present`);
    }

    // 5 — needs.
    if (man.needs !== undefined) {
      if (typeof man.needs !== 'object' || man.needs === null || Array.isArray(man.needs)) {
        problems.push(`${where}: "needs" must be an object`);
      } else {
        for (const [key, allowed] of [['doors', DOORS], ['parts', PARTS]]) {
          const v = man.needs[key];
          if (v === undefined) continue;
          if (!isStringArray(v)) {
            problems.push(`${where}: "needs.${key}" must be an array of strings`);
            continue;
          }
          for (const item of v) {
            if (!allowed.includes(item)) {
              problems.push(`${where}: "needs.${key}" contains ${JSON.stringify(item)}; must be one of ${allowed.join(', ')}`);
            }
          }
        }
        if (man.needs.mods !== undefined && !isStringArray(man.needs.mods)) {
          problems.push(`${where}: "needs.mods" must be an array of strings`);
        }
      }
    }

    // 3 — the shape the kind promises.
    const rootJs = [...rootNames].filter((n) => n.endsWith('.js'));
    if (man.kind === 'script') {
      if (rootJs.length !== 1) {
        problems.push(`scripts/${id}: kind "script" needs exactly one .js file at the entry root, found ${rootJs.length}`
          + (rootJs.length ? ` (${rootJs.sort().join(', ')})` : ''));
      }
      if (all.some((f) => f.path === 'ui' || f.path.startsWith('ui/'))) {
        problems.push(`scripts/${id}: kind "script" must not have a ui/ directory — use kind "app"`);
      }
    } else if (man.kind === 'app') {
      if (!rootNames.has('entrypoint.js') && !rootNames.has('index.html')) {
        problems.push(`scripts/${id}: kind "app" needs entrypoint.js or index.html at the entry root`);
      }
    }
  }

  // 4 — the installable set, and its count.
  const installable = all.filter((f) => f.path !== 'silica.json' && f.path !== 'README.md');
  if (installable.length === 0) {
    problems.push(`scripts/${id}: has no installable files — an entry that installs nothing is not an entry`);
  }
  if (installable.length > MAX_ENTRY_FILES) {
    problems.push(`scripts/${id}: has ${installable.length} installable files, over the limit of ${MAX_ENTRY_FILES}`);
  }

  if (problems.length !== before) return null;

  const files = installable
    .map((f) => ({ path: f.path, sha256: sha256Hex(readFileSync(f.abs)), bytes: f.bytes }))
    .sort((a, b) => comparePaths(a.path, b.path));

  const record = {
    id: man.id,
    title: man.title,
    summary: man.summary,
    kind: man.kind,
    category: man.category,
    author: man.author,
  };
  if (man.needs !== undefined) record.needs = man.needs;
  if (man.minSilica !== undefined) record.minSilica = man.minSilica;
  record.readme = `scripts/${id}/README.md`;
  record.digest = folderDigest(files);
  record.files = files;
  return record;
}

// ---------------------------------------------------------------------------------------- catalog

function buildCatalog(problems) {
  let dirents;
  try {
    dirents = readdirSync(SCRIPTS_DIR, { withFileTypes: true });
  } catch (err) {
    problems.push(`scripts/: cannot be read — ${err.message}`);
    return [];
  }

  const ids = [];
  for (const d of dirents) {
    if (d.isSymbolicLink()) {
      problems.push(`scripts/${d.name}: is a symlink — symlinks are not allowed in a catalog`);
      continue;
    }
    if (d.name.startsWith('.')) {
      problems.push(`scripts/${d.name}: dotfiles and dot-directories are not allowed`);
      continue;
    }
    if (!d.isDirectory()) {
      problems.push(`scripts/${d.name}: scripts/ holds one directory per entry and nothing else`);
      continue;
    }
    ids.push(d.name);
  }
  ids.sort(comparePaths);

  const entries = [];
  for (const id of ids) {
    const record = readEntry(id, problems);
    if (record) entries.push(record);
  }
  return entries;
}

/** ISO-8601 UTC, second precision. */
function nowIso() {
  return new Date().toISOString().replace(/\.\d+Z$/, 'Z');
}

function main(argv) {
  const check = argv.includes('--check');
  const write = argv.includes('--write');
  if (check === write) {
    process.stderr.write('usage: node tools/build-index.mjs --check | --write\n');
    return 2;
  }

  const problems = [];
  const entries = buildCatalog(problems);

  if (problems.length > 0) {
    process.stderr.write(`${problems.length} problem(s) found:\n`);
    for (const p of problems) process.stderr.write(`  - ${p}\n`);
    process.stderr.write('index.json was not written.\n');
    return 1;
  }

  const fileCount = entries.reduce((n, e) => n + e.files.length, 0);
  process.stdout.write(`ok: ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}, ${fileCount} installable file(s)\n`);
  if (!write) return 0;

  // Only the content decides whether index.json changed. Rewriting it just to move `generated`
  // forward would make every push to main produce a commit that says nothing.
  const body = { version: CATALOG_VERSION, name: CATALOG_NAME, entries };
  let existing = null;
  try {
    existing = JSON.parse(readFileSync(INDEX_PATH, 'utf8'));
  } catch { /* absent or unreadable: write a fresh one */ }
  if (existing) {
    const same = JSON.stringify({ version: existing.version, name: existing.name, entries: existing.entries });
    if (same === JSON.stringify(body)) {
      process.stdout.write('index.json is already up to date; left untouched\n');
      return 0;
    }
  }

  const out = { version: CATALOG_VERSION, name: CATALOG_NAME, generated: nowIso(), entries };
  writeFileSync(INDEX_PATH, `${JSON.stringify(out, null, 2)}\n`);
  process.stdout.write(`wrote index.json (generated ${out.generated})\n`);
  return 0;
}

process.exit(main(process.argv.slice(2)));
