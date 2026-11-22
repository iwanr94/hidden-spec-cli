// mend: one patch tool for every AI edit format. It reads a patch in one of four
// formats (unified diff, SEARCH/REPLACE blocks, V4A, JSON edits), finds the lines
// each edit names at the first of three matching tiers, and writes every change
// or none, printing what it changed or why it failed. SPEC.md is the contract.
// Node 22, standard library alone; run as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and
// then this file hands over to runner.ts (the last lines below): keep that
// hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** Thrown to stop with an exit-2 line (usage, no-patch, format, parse). */
class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

/** Thrown by one edit that fails; the edit changes nothing, later edits still run. */
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

/** A patch's lines: split at \n, one trailing \r removed, no empty piece after a final \n. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file's lines, its line break, and whether it ends with one (SPEC section 3). */
interface SplitFile {
  lines: string[];
  br: string;
  final: boolean;
}

function splitFile(text: string): SplitFile {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const final = text.endsWith(br);
  const parts = text.split(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function joinFile(f: SplitFile): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted). */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Moves a successful edit made: [old path, new path], for the R output lines. */
  moves: Array<[string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

// ---- matching lines (SPEC section 5) ----

const trail = (s: string): string => s.replace(/[ \t]+$/, '');
const both = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const lead = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trail(a) === trail(b);
  return both(a) === both(b);
}

/** Positions where O occurs in the file lines at one tier (occurrences may overlap). */
function occurrencesAt(file: string[], old: string[], tier: number): number[] {
  const out: number[] = [];
  if (old.length === 0 || old.length > file.length) return out;
  for (let i = 0; i + old.length <= file.length; i += 1) {
    let ok = true;
    for (let j = 0; j < old.length; j += 1) {
      if (!lineEq(file[i + j]!, old[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs, with its positions; null when it never occurs. */
function findTier(file: string[], old: string[], strict = false): { tier: number; pos: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const pos = occurrencesAt(file, old, tier);
    if (pos.length > 0) return { tier, pos };
  }
  return null;
}

/**
 * One line of the new text: either a context line, written as the file's own
 * matched line, or an added line, written as the patch wrote it (re-indented
 * at tier 2).
 */
interface NewLine {
  ctx: number; // index into O when >= 0, else -1 for an added line
  text: string;
}

/** Build the replacement lines for a match at `at`, honouring context lines and tier 2. */
function replacement(file: string[], old: string[], fresh: NewLine[], at: number, tier: number): string[] {
  const out: string[] = [];
  for (const n of fresh) {
    if (n.ctx >= 0) {
      out.push(file[at + n.ctx]!);
      continue;
    }
    if (tier === 2) {
      const f = lead(file[at]!);
      const p = lead(old[0]!);
      if (n.text !== '' && n.text.trim() !== '' && n.text.startsWith(p)) {
        out.push(f + n.text.slice(p.length));
        continue;
      }
    }
    out.push(n.text);
  }
  return out;
}

/**
 * Replace O (found at `at`) by the fresh lines in a file, keeping the file's
 * line break and its final break.
 */
function spliceLines(before: string, old: string[], fresh: NewLine[], at: number, tier: number): string {
  const f = splitFile(before);
  const rep = replacement(f.lines, old, fresh, at, tier);
  f.lines.splice(at, old.length, ...rep);
  return joinFile(f);
}

// ---- detecting the format (SPEC section 4) ----

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---- JSON edits (SPEC section 9) ----

/** One JSON edit object, or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const need = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = need(tree);
      const f = splitFile(before);
      const crlf = f.br === '\r\n';
      // In a CRLF file the text and both strings are read with every \r\n as \n.
      const norm = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = norm(before);
      const old = norm(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + norm(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = need(tree);
      const f = splitFile(before);
      if (line < 0 || line > f.lines.length) throw new Fail('no-match', p);
      f.lines.splice(line, 0, ...add);
      tree.now.set(p, joinFile(f));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---- unified diffs (SPEC section 6) ----

interface HunkBody {
  kind: ' ' | '-' | '+' | '\\';
  text: string;
}

interface Hunk {
  a: number;
  body: HunkBody[];
}

interface Section {
  oldPath: string | null; // null: /dev/null
  newPath: string | null;
  creation: boolean;
  deletion: boolean;
  hunks: Hunk[];
}

/** The path a --- or +++ line names: after the four characters, up to the first tab, spaces removed. */
function headerPath(line: string): string {
  let p = line.slice(4).split('\t')[0]!.trim();
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

const DIFF_GIT = /^diff --git a\/(\S+) b\/(\S+)\s*$/;
const HUNK_HEAD = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let i = 0;
  // Parse one hunk at lines[i] (a line starting with @@); the header must be
  // of the form @@ -A[,B] +C[,D] @@, optionally followed by text.
  const parseHunk = (): Hunk => {
    const m = HUNK_HEAD.exec(lines[i]!);
    if (m === null) throw new Exit2(`error: parse ${i + 1}`);
    const hunk: Hunk = { a: Number(m[1]), body: [] };
    i += 1;
    while (i < lines.length) {
      const l = lines[i]!;
      if (l.startsWith('diff --git ')) break;
      if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
      if (l === '') hunk.body.push({ kind: ' ', text: '' });
      else if (l[0] === ' ' || l[0] === '-' || l[0] === '+' || l[0] === '\\') hunk.body.push({ kind: l[0] as HunkBody['kind'], text: l.slice(1) });
      else break;
      i += 1;
    }
    // Empty lines at the end of a body are not part of it.
    while (hunk.body.length > 0) {
      const last = hunk.body[hunk.body.length - 1]!;
      if (last.kind === ' ' && last.text === '') hunk.body.pop();
      else break;
    }
    return hunk;
  };
  // Parse one section's header and hunks, starting at lines[i]. The git paths
  // are used when nothing else names one.
  const parseSection = (sec: Section, gitOld: string | null, gitNew: string | null): void => {
    let oldH: string | null = null;
    let newH: string | null = null;
    let renOld: string | null = null;
    let renNew: string | null = null;
    while (i < lines.length) {
      const l = lines[i]!;
      const inHeader = sec.hunks.length === 0;
      if (l.startsWith('diff --git ')) break;
      if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        if (oldH === null && inHeader) {
          oldH = headerPath(l);
          i += 1;
          continue;
        }
        break;
      }
      if (l.startsWith('@@')) {
        sec.hunks.push(parseHunk());
        continue;
      }
      if (l.startsWith('--- ')) {
        if (inHeader) throw new Exit2(`error: parse ${i + 2}`);
        i += 1;
        continue;
      }
      if (inHeader && l.startsWith('+++ ')) newH = headerPath(l);
      else if (inHeader && l.startsWith('rename from ')) renOld = l.slice('rename from '.length).trim();
      else if (inHeader && l.startsWith('rename to ')) renNew = l.slice('rename to '.length).trim();
      else if (inHeader && l.startsWith('new file mode')) sec.creation = true;
      else if (inHeader && l.startsWith('deleted file mode')) sec.deletion = true;
      i += 1;
    }
    const devNull = (p: string | null): string | null => (p === '/dev/null' ? null : p);
    sec.oldPath = devNull(oldH ?? renOld ?? gitOld);
    sec.newPath = devNull(newH ?? renNew ?? gitNew);
  };
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = DIFF_GIT.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const sec: Section = { oldPath: null, newPath: null, creation: false, deletion: false, hunks: [] };
      i += 1;
      parseSection(sec, m[1]!, m[2]!);
      sections.push(sec);
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const sec: Section = { oldPath: null, newPath: null, creation: false, deletion: false, hunks: [] };
      parseSection(sec, null, null);
      sections.push(sec);
      continue;
    }
    if (l.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
    i += 1;
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((sec) => sectionEdit(sec, strict));
}

/** Whether a `\` line follows the hunk's last context or `+` line. */
function noNewlineAfter(hunk: Hunk): boolean {
  let last = -1;
  for (let k = 0; k < hunk.body.length; k += 1) {
    if (hunk.body[k]!.kind === ' ' || hunk.body[k]!.kind === '+') last = k;
  }
  if (last < 0) return false;
  return hunk.body[last + 1] !== undefined && hunk.body[last + 1]!.kind === '\\';
}

/** Apply a section's hunks in order to a file's text (SPEC section 6). */
function applyHunks(before: string, hunks: Hunk[], strict: boolean, path: string): string {
  let text = before;
  let d = 0;
  for (const hunk of hunks) {
    const old: string[] = [];
    const fresh: NewLine[] = [];
    for (const e of hunk.body) {
      if (e.kind === ' ') {
        old.push(e.text);
        fresh.push({ ctx: old.length - 1, text: e.text });
      } else if (e.kind === '-') old.push(e.text);
      else if (e.kind === '+') fresh.push({ ctx: -1, text: e.text });
    }
    const f = splitFile(text);
    const noNl = noNewlineAfter(hunk);
    if (old.length > 0) {
      const found = findTier(f.lines, old, strict);
      if (found === null) throw new Fail('no-match', path);
      const target = hunk.a - 1 + d;
      let best = found.pos[0]!;
      for (const p of found.pos) {
        if (Math.abs(p - target) < Math.abs(best - target)) best = p;
      }
      const atEnd = best + old.length === f.lines.length;
      const rep = replacement(f.lines, old, fresh, best, found.tier);
      f.lines.splice(best, old.length, ...rep);
      if (atEnd) f.final = !noNl;
      text = joinFile(f);
    } else {
      const at = Math.max(0, Math.min(hunk.a + d, f.lines.length));
      const atEnd = at === f.lines.length;
      f.lines.splice(at, 0, ...fresh.map((n) => n.text));
      if (atEnd) f.final = !noNl;
      text = joinFile(f);
    }
    d += fresh.length - old.length;
  }
  return text;
}

/** The text of a created file: the `+` lines of all its hunks, in order. */
function creationText(hunks: Hunk[]): string {
  const plus: string[] = [];
  let noNl = false;
  for (const hunk of hunks) {
    for (const e of hunk.body) {
      if (e.kind === '+') plus.push(e.text);
    }
    if (hunk.body.some((e) => e.kind === '+')) noNl = noNewlineAfter(hunk);
  }
  if (plus.length === 0) return '';
  return plus.join('\n') + (noNl ? '' : '\n');
}

function sectionEdit(sec: Section, strict: boolean): Edit {
  return (tree) => {
    const oldP = sec.oldPath;
    const newP = sec.newPath;
    const isCreation = oldP === null || sec.creation;
    const isDeletion = !isCreation && (newP === null || sec.deletion);
    if (isCreation) {
      if (newP === null) throw new Fail('unsafe', '/dev/null');
      if (!safe(newP)) throw new Fail('unsafe', newP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      tree.now.set(newP, creationText(sec.hunks));
      return;
    }
    if (isDeletion) {
      if (oldP === null) throw new Fail('unsafe', '/dev/null');
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    const p = oldP!;
    const q = newP!;
    if (!safe(p)) throw new Fail('unsafe', p);
    if (!safe(q)) throw new Fail('unsafe', q);
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    if (p !== q) {
      if (tree.get(q) !== null) throw new Fail('exists', q);
      const out = applyHunks(before, sec.hunks, strict, p);
      tree.now.set(p, null);
      tree.now.set(q, out);
      tree.moves.push([p, q]);
      return;
    }
    tree.now.set(p, applyHunks(before, sec.hunks, strict, p));
  };
}

// ---- SEARCH/REPLACE blocks (SPEC section 7) ----

interface SrBlock {
  path: string;
  searchLine: number; // 1-based line of the <<<<<<< SEARCH line
  oldLines: string[];
  newLines: string[];
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const blocks: SrBlock[] = [];
  let i = 0;
  let prevReplace = -1; // index of the previous block's >>>>>>> REPLACE line
  let prevPath: string | null = null;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchIdx = i;
    // The path is the nearest line before the SEARCH line, after the previous
    // block's REPLACE line, that is not blank and does not start with ```.
    let path: string | null = null;
    for (let k = searchIdx - 1; k > prevReplace; k -= 1) {
      const t = lines[k]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
    // Find ======= then >>>>>>> REPLACE after the SEARCH line.
    let eq = -1;
    let rep = -1;
    for (let k = searchIdx + 1; k < lines.length; k += 1) {
      const t = lines[k]!.trimEnd();
      if (eq < 0 && t === '=======') eq = k;
      else if (eq >= 0 && t === '>>>>>>> REPLACE') {
        rep = k;
        break;
      }
    }
    if (eq < 0 || rep < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    blocks.push({
      path,
      searchLine: searchIdx + 1,
      oldLines: lines.slice(searchIdx + 1, eq),
      newLines: lines.slice(eq + 1, rep),
    });
    prevReplace = rep;
    prevPath = path;
    i = rep + 1;
  }
  if (blocks.length === 0) throw new Exit2('error: parse 1');
  return blocks.map((b) => (tree) => {
    if (!safe(b.path)) throw new Fail('unsafe', b.path);
    if (b.oldLines.length === 0) {
      if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
      tree.now.set(b.path, b.newLines.length === 0 ? '' : `${b.newLines.join('\n')}\n`);
      return;
    }
    const before = tree.get(b.path);
    if (before === null) throw new Fail('missing', b.path);
    const f = splitFile(before);
    const found = findTier(f.lines, b.oldLines, strict);
    if (found === null) throw new Fail('no-match', b.path);
    if (found.pos.length > 1) throw new Fail('ambiguous', b.path);
    const at = found.pos[0]!;
    const fresh: NewLine[] = b.newLines.map((t) => ({ ctx: -1, text: t }));
    tree.now.set(b.path, spliceLines(before, b.oldLines, fresh, at, found.tier));
  });
}

// ---- V4A patches (SPEC section 8) ----

interface VChunk {
  anchor: string | null;
  eof: boolean;
  old: string[];
  fresh: NewLine[];
}

interface VSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  moveTo: string | null;
  lines: string[]; // Add File: the file's lines
  chunks: VChunk[];
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0 || lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first < 0 ? 1 : first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k -= 1) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: VSection[] = [];
  let i = first + 1;
  // Read one section starting at lines[i] (an Add/Delete/Update File line).
  const readSection = (): void => {
    const head = lines[i]!;
    let sec: VSection;
    if (head.startsWith('*** Add File: ')) sec = { kind: 'add', path: head.slice('*** Add File: '.length).trim(), moveTo: null, lines: [], chunks: [] };
    else if (head.startsWith('*** Delete File: ')) sec = { kind: 'delete', path: head.slice('*** Delete File: '.length).trim(), moveTo: null, lines: [], chunks: [] };
    else sec = { kind: 'update', path: head.slice('*** Update File: '.length).trim(), moveTo: null, lines: [], chunks: [] };
    const start = i;
    i += 1;
    // Collect the section's raw lines (blank lines at its end are not part of it).
    const raw: string[] = [];
    while (i < last) {
      const l = lines[i]!;
      if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ')) break;
      raw.push(l);
      i += 1;
    }
    while (raw.length > 0 && blank(raw[raw.length - 1]!)) raw.pop();
    if (sec.kind === 'add') {
      for (let k = 0; k < raw.length; k += 1) {
        const l = raw[k]!;
        if (l.startsWith('+')) sec.lines.push(l.slice(1));
        else if (l === '') sec.lines.push('');
        else throw new Exit2(`error: parse ${start + 2 + k}`);
      }
    } else if (sec.kind === 'delete') {
      if (raw.length > 0) throw new Exit2(`error: parse ${start + 2}`);
    } else {
      // Update File: optional *** Move to: as the first line, then chunks.
      let at = 0;
      if (raw.length > 0 && raw[0]!.startsWith('*** Move to: ')) {
        sec.moveTo = raw[0]!.slice('*** Move to: '.length).trim();
        at = 1;
      }
      let cur: VChunk | null = null;
      const closeChunk = (): void => {
        if (cur !== null) sec.chunks.push(cur);
        cur = null;
      };
      for (; at < raw.length; at += 1) {
        const l = raw[at]!;
        if (l === '*** End of File') {
          if (cur === null) cur = { anchor: null, eof: false, old: [], fresh: [] };
          cur.eof = true;
          closeChunk();
          continue;
        }
        if (l.startsWith('@@')) {
          closeChunk();
          cur = { anchor: l.slice(2).trim(), eof: false, old: [], fresh: [] };
          continue;
        }
        if (l.startsWith('*** Move to: ')) throw new Exit2(`error: parse ${start + 2 + at}`);
        if (l.startsWith('*** ')) throw new Exit2(`error: parse ${start + 2 + at}`);
        if (cur === null) cur = { anchor: null, eof: false, old: [], fresh: [] };
        if (l === '') {
          cur.old.push('');
          cur.fresh.push({ ctx: cur.old.length - 1, text: '' });
        } else if (l[0] === ' ') {
          cur.old.push(l.slice(1));
          cur.fresh.push({ ctx: cur.old.length - 1, text: l.slice(1) });
        } else if (l[0] === '-') cur.old.push(l.slice(1));
        else if (l[0] === '+') cur.fresh.push({ ctx: -1, text: l.slice(1) });
        else throw new Exit2(`error: parse ${start + 2 + at}`);
      }
      closeChunk();
      if (sec.chunks.length === 0 && sec.moveTo === null) throw new Exit2(`error: parse ${start + 1}`);
    }
    sections.push(sec);
  };
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i += 1;
      continue;
    }
    if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ')) {
      readSection();
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((sec) => (tree) => {
    if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
    if (sec.moveTo !== null && !safe(sec.moveTo)) throw new Fail('unsafe', sec.moveTo);
    if (sec.kind === 'add') {
      if (tree.get(sec.path) !== null) throw new Fail('exists', sec.path);
      tree.now.set(sec.path, sec.lines.length === 0 ? '' : `${sec.lines.join('\n')}\n`);
      return;
    }
    if (sec.kind === 'delete') {
      if (tree.get(sec.path) === null) throw new Fail('missing', sec.path);
      tree.now.set(sec.path, null);
      return;
    }
    const before = tree.get(sec.path);
    if (before === null) throw new Fail('missing', sec.path);
    if (sec.moveTo !== null) {
      if (tree.get(sec.moveTo) !== null) throw new Fail('exists', sec.moveTo);
    }
    const out = applyVChunks(before, sec.chunks, strict, sec.path);
    if (sec.moveTo !== null) {
      tree.now.set(sec.path, null);
      tree.now.set(sec.moveTo, out);
      tree.moves.push([sec.path, sec.moveTo]);
    } else {
      tree.now.set(sec.path, out);
    }
  });
}

/** Apply an Update File section's chunks in order, with a cursor (SPEC section 8). */
function applyVChunks(before: string, chunks: VChunk[], strict: boolean, path: string): string {
  let text = before;
  let cursor = 0;
  for (const chunk of chunks) {
    const f = splitFile(text);
    // An anchored chunk first finds its anchor line at or after the cursor.
    if (chunk.anchor !== null && chunk.anchor !== '') {
      const found = findTier(f.lines.slice(cursor), [chunk.anchor], strict);
      if (found === null) throw new Fail('no-match', path);
      cursor += found.pos[0]! + 1;
    }
    if (chunk.old.length === 0) {
      const at = chunk.eof ? f.lines.length : cursor;
      f.lines.splice(at, 0, ...chunk.fresh.map((n) => n.text));
      cursor = at + chunk.fresh.length;
      text = joinFile(f);
      continue;
    }
    const rest = f.lines.slice(cursor);
    const found = findTier(rest, chunk.old, strict);
    if (found === null) throw new Fail('no-match', path);
    let at = -1;
    for (const p of found.pos) {
      if (chunk.eof && cursor + p + chunk.old.length !== f.lines.length) continue;
      at = cursor + p;
      break;
    }
    if (at < 0) throw new Fail('no-match', path);
    const rep = replacement(f.lines, chunk.old, chunk.fresh, at, found.tier);
    f.lines.splice(at, chunk.old.length, ...rep);
    cursor = at + rep.length;
    text = joinFile(f);
  }
  return text;
}

// ---- the command line (SPEC sections 1, 2 and 10) ----

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  // Edits apply in the patch's order to the tree as earlier edits left it. A
  // failed edit changes nothing, and the edits after it still run.
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  }
  // One line for each path whose state changed, in byte order of the paths. A
  // move replaces its pair's D and A lines and sorts by its new path.
  const rows: Array<{ key: string; line: string }> = [];
  const moved = new Set<string>();
  for (const [o, n] of tree.moves) {
    if (tree.original(o) !== null && tree.get(o) === null && tree.original(n) === null && tree.get(n) !== null) {
      rows.push({ key: n, line: `R ${o} -> ${n}` });
      moved.add(o);
      moved.add(n);
    }
  }
  for (const p of tree.now.keys()) {
    if (moved.has(p)) continue;
    const was = tree.original(p);
    const now = tree.get(p);
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of tree.now.keys()) {
      const now = tree.get(p);
      if (now === tree.original(p)) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  const linesOut = rows.map((r) => r.line);
  return { code: 0, out: [...linesOut, `ok: ${linesOut.length} ${linesOut.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}





