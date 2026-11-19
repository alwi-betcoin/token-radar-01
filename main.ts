// Token Radar entrypoint (Node 22, standard library only).
//
// Reads the sealed snapshot from /input/snapshot.json (or --input <file|dir>), fits the comparables
// curve in lib/model.ts, ranks every protocol that records no token, and writes the hand-in:
//   /output/board.json    the ranked board (the gate reads this)
//   /output/data.js       the same figures, for the dashboard page beside it
//   /output/dashboard/    a copy of this repository's dashboard/
//   /output/screenshots/  a copy of this repository's screenshots/
//   /output/dossier.json  the judge's summary, written by the vendored make.fun library
// Two runs write the same bytes: the model is pure arithmetic on the snapshot, with no clock,
// no randomness and no network anywhere in it.
//
// Outside the grader's container, MAKEFUN_OUTPUT_DIR stands in for /output:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardIssue, buildRadar, dataScript, parseSnapshot } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const here = fileURLToPath(new URL('.', import.meta.url));

/** The dossier's text cap: past it the judge reads a cut source, so the dashboard stays under it. */
const TEXT_MAX_BYTES = 65_536;

/** --name <value> out of the arguments, or the fallback. */
function arg(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  if (at >= 0 && at + 1 < process.argv.length) return process.argv[at + 1]!;
  const withEquals = process.argv.find((a) => a.startsWith(`--${name}=`));
  return withEquals === undefined ? fallback : withEquals.slice(name.length + 3);
}

const inputArg = arg('input', '/input');
const inputFile = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
if (!existsSync(inputFile)) {
  process.stderr.write(`token radar: no snapshot at ${inputFile}: pass --input <snapshot.json|directory> or mount the sealed /input\n`);
  process.exit(2);
}
const out = arg('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

const snapshot = parseSnapshot(readFileSync(inputFile, 'utf8'));
const { board, radar } = buildRadar(snapshot);
const issue = boardIssue(board, snapshot);
if (issue !== null) {
  process.stderr.write(`token radar: the model wrote a board the gate refuses: ${issue}\n`);
  process.exit(1);
}

mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'board.json'), `${JSON.stringify({ rows: board })}\n`);
writeFileSync(join(out, 'data.js'), dataScript(radar));

/** Copy one directory's regular files into `to`, skipping names that start with a dot. */
function copyFiles(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const copied: string[] = [];
  for (const name of readdirSync(from).sort()) {
    if (name.startsWith('.')) continue;
    const src = join(from, name);
    if (statSync(src).isDirectory()) {
      copied.push(...copyFiles(src, join(to, name)));
    } else {
      copyFileSync(src, join(to, name));
      copied.push(name);
    }
  }
  return copied;
}

copyFiles(join(here, 'dashboard'), join(out, 'dashboard'));
copyFiles(join(here, 'screenshots'), join(out, 'screenshots'));

const dossier = buildDossier(out, { text_max_bytes: TEXT_MAX_BYTES });
writeFileSync(join(out, 'dossier.json'), dossier);
process.stdout.write(`token radar: ${board.length} rows, watchlist ${radar.coverage.watchlist_covered}/${radar.coverage.watchlist}, dossier ${dossier.length} bytes\n`);
