import { countWords } from '../read-aloud/help-prompt';
import { headingLevelOf, maskFencesKeepingLength } from '../classroom/links';

/**
 * The section resolver (`featrues/15-convert-readable/spec.md` §6, §7.2):
 * the document's outline, the h2 units a request covers, the word counts of
 * a unit by kind, and the check that the preview and the file agree.
 *
 * The webview never sees the markdown, so this runs in the host over the
 * source text; the webview supplies two one-based line numbers and an
 * anchor. Every line number here is one-based, as crossnote's
 * `data-source-line` is (§6.1).
 *
 * Pure module: no `vscode`, no I/O.
 */

export interface OutlineHeading {
  level: number;
  text: string;
  /** One-based. */
  line: number;
}

export interface SectionUnit {
  n: number;
  heading: string;
  level: number;
  /** One-based, inclusive; `endLine` is the unit's last non-blank line. */
  line: number;
  endLine: number;
  /** The text before the first h2, headed by the h1 or the file name (§6.2). */
  preamble: boolean;
}

export interface SectionCover {
  startLine: number;
  endLine: number;
}

export interface UnitsOptions {
  /** What a preamble unit is headed by when the document has no h1. */
  fileName?: string;
}

export type UnitsResult =
  | { ok: true; units: SectionUnit[]; widened: boolean }
  | { ok: false; reason: 'no-sections' };

export interface SectionStats {
  words: number;
  codeWords: number;
  tableWords: number;
  proseWords: number;
  fences: number;
  tables: number;
}

export type CoverCheck =
  | { ok: true; startLine: number; moved: boolean }
  | { ok: false; reason: 'ambiguous' | 'missing' };

/** §6.3 — how many lines either side of the cover the anchor is looked for. */
export const COVER_CHECK_WINDOW_LINES = 5;
/** §6.3 — how many non-space characters of the anchor's `exact` are compared. */
export const COVER_CHECK_CHARS = 40;

const DEFAULT_HEADING = 'Document';
const FENCE_OPEN_RE = /^\s*(`{3,}|~{3,})/;

// ------------------------------------------------------------------ lines

function normaliseNewlines(source: string): string {
  return typeof source === 'string' ? source.replace(/\r\n?/g, '\n') : '';
}

/** The lines of the source; a trailing newline adds no empty line. */
function linesOf(source: string): string[] {
  const text = normaliseNewlines(source);
  if (!text) {
    return [];
  }
  const lines = text.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines;
}

export function lineCount(source: string): number {
  return linesOf(source).length;
}

/**
 * The one-based line after a YAML front matter block at the top of the
 * source (`---` … `---`), or 1 when there is none. Front matter belongs to
 * no unit and carries no heading (§6.2).
 */
function contentStartLine(lines: string[]): number {
  if (lines.length < 2 || lines[0].trim() !== '---') {
    return 1;
  }
  for (let i = 1; i < lines.length; i++) {
    if (/^(---|\.\.\.)\s*$/.test(lines[i])) {
      return i + 2;
    }
  }
  return 1;
}

/** The source with its fences and its front matter blanked, lengths kept. */
function maskedLines(source: string): string[] {
  const text = normaliseNewlines(source);
  const masked = maskFencesKeepingLength(text).prose;
  const lines = linesOf(masked);
  const start = contentStartLine(linesOf(text));
  for (let i = 0; i < start - 1 && i < lines.length; i++) {
    lines[i] = '';
  }
  return lines;
}

/** `sectionText` — the lines `line..endLine`, newline-joined, no trailing newline. */
export function sectionText(
  source: string,
  unit: { line: number; endLine: number },
): string {
  const lines = linesOf(source);
  const from = Math.max(1, unit.line);
  const to = Math.min(lines.length, unit.endLine);
  if (to < from) {
    return '';
  }
  return lines.slice(from - 1, to).join('\n');
}

// --------------------------------------------------------------- headings

/** Emphasis markers and backticks stripped, whitespace collapsed, trailing `#`s dropped. */
export function normaliseHeadingText(text: string): string {
  return (typeof text === 'string' ? text : '')
    .replace(/[*_`]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*#+\s*$/, '')
    .trim();
}

export function sameHeading(a: string, b: string): boolean {
  return (
    normaliseHeadingText(a).toLowerCase() ===
    normaliseHeadingText(b).toLowerCase()
  );
}

/** §6.2 — every ATX heading outside fences and front matter, one-based lines. */
export function outlineOf(source: string): OutlineHeading[] {
  const out: OutlineHeading[] = [];
  const lines = maskedLines(source);
  for (let i = 0; i < lines.length; i++) {
    const heading = headingLevelOf(lines[i]);
    if (heading) {
      out.push({ level: heading.level, text: heading.text, line: i + 1 });
    }
  }
  return out;
}

/** The unit's own headings, its heading line first. */
export function headingsIn(
  outline: OutlineHeading[],
  unit: { line: number; endLine: number },
): OutlineHeading[] {
  return outline.filter(
    (heading) => heading.line >= unit.line && heading.line <= unit.endLine,
  );
}

/**
 * The headings above the unit, outermost first, nearest of each level, the
 * way `helpContext`'s breadcrumb walks: an h2 unit under an h1 gives the h1.
 */
export function breadcrumbFor(
  outline: OutlineHeading[],
  unit: { line: number; level: number },
): string[] {
  const crumbs: string[] = [];
  let minLevel = unit.level;
  for (let i = outline.length - 1; i >= 0; i--) {
    const heading = outline[i];
    if (heading.line >= unit.line) {
      continue;
    }
    if (heading.level >= minLevel) {
      continue;
    }
    crumbs.unshift(heading.text);
    minLevel = heading.level;
    if (heading.level === 1) {
      break;
    }
  }
  return crumbs;
}

// ------------------------------------------------------------------ units

function isBlankLine(line: string): boolean {
  return line.trim() === '';
}

/** The last non-blank line at or before `to`, never before `from`. */
function trimTrailingBlank(lines: string[], from: number, to: number): number {
  let end = to;
  while (end > from && isBlankLine(lines[end - 1])) {
    end--;
  }
  return end;
}

/** The first non-blank line at or after `from`, never after `to`. */
function trimLeadingBlank(lines: string[], from: number, to: number): number {
  let start = from;
  while (start < to && isBlankLine(lines[start - 1])) {
    start++;
  }
  return start;
}

/**
 * §6.2 — every unit of the document in order: the preamble (the text before
 * the first h1 or h2, headed by the file name, or the text between an h1
 * and the next h2, headed by the h1) when it has any content of its own,
 * and one unit per h2 section. A document with neither h1 nor h2 is one
 * unit covering the whole file.
 */
export function allUnits(
  source: string,
  options: UnitsOptions = {},
): SectionUnit[] {
  const lines = linesOf(source);
  const total = lines.length;
  if (!total) {
    return [];
  }
  const fileName = options.fileName || DEFAULT_HEADING;
  const start = contentStartLine(lines);
  const starters = outlineOf(source).filter((heading) => heading.level <= 2);
  const units: SectionUnit[] = [];

  const hasContent = (from: number, to: number): boolean => {
    for (let i = from; i <= to; i++) {
      if (!isBlankLine(lines[i - 1])) {
        return true;
      }
    }
    return false;
  };

  const push = (
    heading: string,
    level: number,
    line: number,
    endLine: number,
    preamble: boolean,
  ) => {
    units.push({
      n: units.length + 1,
      heading,
      level,
      line,
      endLine: trimTrailingBlank(lines, line, endLine),
      preamble,
    });
  };

  // The text before the first h1 or h2: a preamble headed by the file name,
  // from its first non-blank line.
  const firstStart = starters.length ? starters[0].line : total + 1;
  if (
    start <= total &&
    firstStart > start &&
    hasContent(start, firstStart - 1)
  ) {
    push(
      fileName,
      1,
      trimLeadingBlank(lines, start, firstStart - 1),
      firstStart - 1,
      true,
    );
  }

  for (let i = 0; i < starters.length; i++) {
    const heading = starters[i];
    const next = i + 1 < starters.length ? starters[i + 1].line : total + 1;
    if (heading.level === 2) {
      push(heading.text, 2, heading.line, next - 1, false);
      continue;
    }
    // An h1: its own text up to the next h1 or h2, when there is any.
    if (next - 1 > heading.line && hasContent(heading.line + 1, next - 1)) {
      push(heading.text, 1, heading.line, next - 1, true);
    }
  }
  return units;
}

/** Where the fence opened at `index` closes (the closer's index), or the last index. */
function fenceEndAt(lines: string[], index: number): number {
  const open = FENCE_OPEN_RE.exec(lines[index]);
  if (!open) {
    return index;
  }
  const marker = open[1];
  const close = new RegExp(
    '^\\s*' + marker[0] + '{' + marker.length + ',}\\s*$',
  );
  for (let i = index + 1; i < lines.length; i++) {
    if (close.test(lines[i])) {
      return i;
    }
  }
  return lines.length - 1;
}

/**
 * The last line of the markdown block that starts at line `at` (one-based):
 * a fence runs to its closer, anything else to the line before the next
 * blank line or heading. The webview sends the *start* line of the last
 * block it resolved (§6.1), which is what this recovers an end from.
 */
function blockEndAt(lines: string[], masked: string[], at: number): number {
  const index = at - 1;
  if (index < 0 || index >= lines.length) {
    return at;
  }
  if (FENCE_OPEN_RE.test(lines[index])) {
    return fenceEndAt(lines, index) + 1;
  }
  let end = index;
  while (
    end + 1 < lines.length &&
    !isBlankLine(lines[end + 1]) &&
    !headingLevelOf(masked[end + 1])
  ) {
    end++;
  }
  return end + 1;
}

/**
 * §6.2 — the units a cover touches. Step 1: a cover whose first line is a
 * heading runs from that heading to the line before the next heading of
 * the same or a higher level, or the end. Step 2: the cover is widened to
 * every unit it touches, in document order. Step 3: a cover on no unit
 * refuses. `widened` says whether the cover was smaller than the units it
 * became.
 */
export function unitsFor(
  source: string,
  cover: SectionCover,
  options: UnitsOptions = {},
): UnitsResult {
  const lines = linesOf(source);
  const total = lines.length;
  const units = allUnits(source, options);
  if (!total || !units.length) {
    return { ok: false, reason: 'no-sections' };
  }
  const masked = maskedLines(source);
  const outline = outlineOf(source);
  const startLine = Math.max(1, Math.min(total, Math.floor(cover.startLine)));
  let endLine = Math.max(startLine, Math.min(total, Math.floor(cover.endLine)));

  // Step 1 — extend a heading to its own section.
  const first = headingLevelOf(masked[startLine - 1]);
  if (first) {
    let end = total;
    for (const heading of outline) {
      if (heading.line > startLine && heading.level <= first.level) {
        end = heading.line - 1;
        break;
      }
    }
    endLine = Math.max(endLine, trimTrailingBlank(lines, startLine, end));
  } else {
    // The cover's last line is the start of a block; the block's end is the
    // cover's real end (§6.1 sends `data-source-line`, a block's first line).
    endLine = Math.max(endLine, blockEndAt(lines, masked, endLine));
  }

  // Step 2 — widen to the units touched. The blank lines between two units
  // belong to the earlier one for this purpose, so a caret on one of them
  // still finds its section.
  const touched: SectionUnit[] = [];
  for (let i = 0; i < units.length; i++) {
    const unit = units[i];
    const reach = i + 1 < units.length ? units[i + 1].line - 1 : total;
    if (unit.line <= endLine && reach >= startLine) {
      touched.push(unit);
    }
  }
  if (!touched.length) {
    return { ok: false, reason: 'no-sections' };
  }
  const widened =
    startLine > touched[0].line ||
    endLine < touched[touched.length - 1].endLine;
  return {
    ok: true,
    units: touched.map((unit, index) => ({ ...unit, n: index + 1 })),
    widened,
  };
}

// ------------------------------------------------------------------ stats

/**
 * §7.2 — the words of one unit by kind: `codeWords` inside fenced blocks
 * (the fence lines included, and a fence nested in a list item counted),
 * `tableWords` on table-row lines outside fences, `proseWords` the rest,
 * so the three always sum to `words`.
 */
export function sectionStats(
  source: string,
  unit: { line: number; endLine: number },
): SectionStats {
  const text = sectionText(source, unit);
  const lines = text ? text.split('\n') : [];
  let codeWords = 0;
  let tableWords = 0;
  let fences = 0;
  let tables = 0;
  let inTable = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (FENCE_OPEN_RE.test(line)) {
      const end = fenceEndAt(lines, i);
      fences++;
      inTable = false;
      for (let k = i; k <= end; k++) {
        codeWords += countWords(lines[k]);
      }
      i = end;
      continue;
    }
    if (/^\s*\|/.test(line)) {
      if (!inTable) {
        tables++;
        inTable = true;
      }
      tableWords += countWords(line);
      continue;
    }
    inTable = false;
  }
  const words = countWords(text);
  return {
    words,
    codeWords,
    tableWords,
    proseWords: Math.max(0, words - codeWords - tableWords),
    fences,
    tables,
  };
}

// ------------------------------------------------------------ cover check

/**
 * What both sides of the cover check are reduced to: letters and digits
 * only. The preview's text is a render, the file is markdown, and the two
 * differ by exactly what this drops: emphasis and code markers, link and
 * image destinations, HTML tags, escapes, the typographer's quotes and
 * dashes, and whitespace. The needle is then specific enough at 40
 * characters and never refused for a `**bold**` start.
 */
export function coverText(text: string): string {
  return text
    .replace(/\]\([^)\n]*\)/g, ']')
    .replace(/<[^>\n]+>/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

/** The needle §6.3 compares: `coverText`, the first 40 characters. */
function coverNeedle(exact: string): string {
  return coverText(typeof exact === 'string' ? exact : '').slice(
    0,
    COVER_CHECK_CHARS,
  );
}

/**
 * The lines `from..to` (one-based, inclusive) reduced by `coverText` and
 * every character mapped back to its line, so a needle that wraps across
 * lines is still found.
 */
function squeeze(
  lines: string[],
  from: number,
  to: number,
): { text: string; lineAt: number[] } {
  let text = '';
  const lineAt: number[] = [];
  for (let n = from; n <= to; n++) {
    const squeezed = coverText(lines[n - 1]);
    text += squeezed;
    for (let c = 0; c < squeezed.length; c++) {
      lineAt.push(n);
    }
  }
  return { text, lineAt };
}

function hitsIn(
  squeezed: { text: string; lineAt: number[] },
  needle: string,
): number[] {
  const hits: number[] = [];
  let at = squeezed.text.indexOf(needle);
  while (at >= 0) {
    hits.push(squeezed.lineAt[at]);
    at = squeezed.text.indexOf(needle, at + needle.length);
  }
  return hits;
}

/**
 * §6.3 — whether the preview's cover still points at the file's text: the
 * anchor's `exact`, whitespace-insensitively, within five lines of
 * `startLine`; else anywhere in the source, one hit re-deriving the line
 * (`moved`), several or none refusing.
 */
export function coverCheck(
  source: string,
  startLine: number,
  exact: string,
): CoverCheck {
  const lines = linesOf(source);
  const needle = coverNeedle(exact);
  if (!needle || !lines.length) {
    return { ok: true, startLine, moved: false };
  }
  const at = Math.max(1, Math.min(lines.length, Math.floor(startLine)));
  const from = Math.max(1, at - COVER_CHECK_WINDOW_LINES);
  const to = Math.min(lines.length, at + COVER_CHECK_WINDOW_LINES);
  if (hitsIn(squeeze(lines, from, to), needle).length) {
    return { ok: true, startLine: at, moved: false };
  }
  const hits = hitsIn(squeeze(lines, 1, lines.length), needle);
  if (hits.length === 1) {
    return { ok: true, startLine: hits[0], moved: hits[0] !== at };
  }
  return { ok: false, reason: hits.length ? 'ambiguous' : 'missing' };
}
