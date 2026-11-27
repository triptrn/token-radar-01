// Token radar: a make.fun entry in plain Node 22, standard library only.
//
// The sealed snapshot is the input: snapshot.json under /input, or whatever
// --input points at (a file or a directory holding one). Every pre-token
// protocol is scored by the radar-2 model in lib/model.ts; the ranked board
// lands in /output/board.json and the dashboard's dataset in /output/data.js.
// The repo's dashboard/ and screenshots/ are copied alongside, and
// /output/dossier.json is written last from the vendored make.fun library, so
// the scorer can rebuild it from the same directory and compare the bytes.
//
// The dashboard itself is a static page — no framework, no network — that
// reads /output/data.js: dashboard/index.html, dashboard/app.css and
// dashboard/app.js, all written from the same board the ranking comes from.
//
// Outside the grader's container, MAKEFUN_OUTPUT_DIR stands in for /output:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json

import { existsSync, mkdirSync, copyFileSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardIssue, buildRadar, dataScript, parseSnapshot } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const repoRoot = fileURLToPath(new URL('./', import.meta.url));

/** The scorer's own caps (reference/gate.json): the text cap shapes the bytes, the rest refuse. */
const TEXT_CAP = 65_536;
const SHOT_LIMITS = { max: 4, max_bytes: 524_288 };
const SHOT_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

/** The value of `--name <value>` or `--name=<value>` on the command line, else `fallback`. */
function flagValue(name: string, fallback: string): string {
  const bare = '--' + name;
  const joined = bare + '=';
  const argv = process.argv;
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === bare && i + 1 < argv.length) return argv[i + 1] as string;
  }
  for (const a of argv) {
    if (a.startsWith(joined)) return a.slice(joined.length);
  }
  return fallback;
}

/** Copy a directory's regular files into `to`, skipping dot-names, and report what landed. */
function copyDir(from: string, to: string): string[] {
  const landed: string[] = [];
  if (!existsSync(from)) return landed;
  mkdirSync(to, { recursive: true });
  const names = readdirSync(from);
  for (const name of names) {
    if (name.charAt(0) === '.') continue;
    const src = join(from, name);
    if (!statSync(src).isFile()) continue;
    copyFileSync(src, join(to, name));
    landed.push(name);
  }
  return landed;
}

/** Write `message` to stderr and leave with `code`. */
function die(message: string, code: number): never {
  process.stderr.write(message);
  process.exit(code);
}

const inputOpt = flagValue('input', '/input');
const inputPath = inputOpt.endsWith('.json') ? inputOpt : join(inputOpt, 'snapshot.json');
const haveInput = existsSync(inputPath);
if (!haveInput) {
  die('token radar: no snapshot at ' + inputPath + ': pass --input <snapshot.json|directory> or mount the sealed /input\n', 2);
}
const outDir = flagValue('output', process.env.MAKEFUN_OUTPUT_DIR !== undefined ? process.env.MAKEFUN_OUTPUT_DIR : '/output');

const snapshot = parseSnapshot(readFileSync(inputPath, 'utf8'));
const { board, radar } = buildRadar(snapshot);
const problem = boardIssue(board, snapshot);
if (problem !== null) {
  die('token radar: the model wrote a board the gate refuses: ' + problem + '\n', 1);
}

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'board.json'), JSON.stringify({ rows: board }) + '\n');
writeFileSync(join(outDir, 'data.js'), dataScript(radar));

/** Refuse a screenshot name the dossier will not take, with the reason the gate gives. */
function checkShotNames(names: string[]): void {
  for (const name of names) {
    if (SHOT_NAME.test(name)) continue;
    die('token radar: screenshots/' + name + ': a name is letters, digits and . _ -, 1 to 128 characters\n', 1);
  }
}

copyDir(join(repoRoot, 'dashboard'), join(outDir, 'dashboard'));
const shots = copyDir(join(repoRoot, 'screenshots'), join(outDir, 'screenshots'));
if (shots.length < 3) {
  die('token radar: screenshots/ holds ' + shots.length + ' image' + (shots.length === 1 ? '' : 's') + ': hand in 3, the board, a detail view and a filtered view\n', 1);
}
checkShotNames(shots);

// The dossier is written last: the scorer rebuilds it from this /output and compares bytes.
writeFileSync(join(outDir, 'dossier.json'), buildDossier(outDir, { text_max_bytes: TEXT_CAP, screenshots: SHOT_LIMITS, dashboard: { max_files: 400, max_bytes: 4_194_304 } }));

process.stdout.write(
  'token radar: ' + snapshot.protocols.length + ' protocols, ' + snapshot.watchlist.length + ' on the watchlist, ' + board.length + ' rows scored (' + radar.early_size + ' early, ' + radar.live_size + ' live set aside)\n' +
  'token radar: wrote ' + join(outDir, 'board.json') + ', ' + join(outDir, 'data.js') + ', ' + join(outDir, 'dashboard') + ' (3 files), ' + join(outDir, 'screenshots') + ' (' + shots.length + ' images) and ' + join(outDir, 'dossier.json') + '\n',
);
