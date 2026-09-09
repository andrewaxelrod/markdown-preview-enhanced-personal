import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { backLink } from '../classroom/module-format';
import { maskFences } from '../classroom/checks';
import type {
  EditionSummary,
  RetellScope,
  RetellSectionState,
  RetellSectionStatus,
  RetellStatus,
} from '../read-aloud/messages';
import {
  RETELL_SCOPES,
  RETELL_SECTION_STATUSES,
  RETELL_STATUSES,
} from '../read-aloud/messages';
import { minutesFor } from './estimate';
import { DEFAULT_RETELL_SHAPE, RETELL_SHAPES } from './retell-prompt';

/**
 * The edition file codec (`featrues/15-convert-readable/spec.md` §10).
 *
 * One markdown file per spoken edition: YAML front matter for the machine
 * part (the units with their ranges, hashes and states, the estimate, the
 * engine, the document), then a body the build appends to and never rewrites
 * — the frame (`h1` and the _You were reading_ line), then each unit's
 * markdown followed by its own back link (D23). The body is kept as a string;
 * the codec knows it only through the unit headings it finds for Continue and
 * Rebuild (§9.8, the one place the body is rewritten) and the link it appends
 * after every unit.
 *
 * Pure module: no `vscode`, no I/O.
 */

export const EDITION_ID_RE = /^\d{8}T\d{6}Z-[0-9a-f]{4}$/;
export const BACK_LINK_TEXT = 'Back to the section';

/** The caps a hand-edited file is held to, the notes' and the classroom's. */
export const EDITION_CAPS = {
  heading: 200,
  title: 200,
  error: 1000,
  hash: 64,
  flagged: 20,
  flag: 40,
  anchorExact: 6000,
  anchorContext: 64,
  anchorBlocks: 50,
  headingLevels: 6,
  headingLevel: 200,
  sections: 1000,
} as const;

export interface EditionAnchor {
  exact: string;
  block: string;
  line: number | null;
  prefix: string;
  suffix: string;
  offset: number;
  blocks: number;
}

export interface EditionSection {
  n: number;
  heading: string;
  level: number;
  line: number;
  endLine: number;
  words: number;
  codeWords: number;
  tableWords: number;
  hash: string;
  status: RetellSectionStatus;
  /** The written edition's word count, once done. */
  actual: number | null;
  /** The check codes the second draft still failed (§9.4). */
  flagged: string[];
  /** How long the unit's calls took. */
  ms: number | null;
  anchor: EditionAnchor;
}

export interface EditionEngine {
  engine: string;
  model: string;
  effort: string;
  /** `RETELL_PROMPT_VERSION` at the time of the build. */
  prompt: number;
}

export interface EditionEstimate {
  sourceWords: number;
  words: number;
  minutes: number;
  ceiling: number;
}

export interface EditionDocument {
  workspace: string;
  path: string;
  absolute: string;
  title: string;
  headings: string[];
  words: number;
  git: { remote: string; commit: string };
}

export interface ParsedEdition {
  id: string;
  created: string;
  updated: string;
  finished: string | null;
  status: RetellStatus;
  stoppedAt: number | null;
  error: string | null;
  /** One of `RETELL_SHAPES`; `brief` is reserved (D3). */
  shape: string;
  scope: RetellScope;
  engine: EditionEngine;
  estimate: EditionEstimate;
  document: EditionDocument;
  sections: EditionSection[];
  /** Front-matter keys the codec does not know, written back unchanged. */
  unknown: Record<string, unknown>;
  /** The markdown after the front matter, verbatim. */
  body: string;
}

export interface EditionParseError {
  error: string;
}

/**
 * A parse error is an object with only `error`; a parsed edition also carries
 * `error` (the build's failure reason, or null), so the test is the absence
 * of `status`, which every edition has.
 */
export function isEditionParseError(
  value: ParsedEdition | EditionParseError,
): value is EditionParseError {
  return (
    !('status' in value) &&
    typeof (value as EditionParseError).error === 'string'
  );
}

// ----------------------------------------------------------------- helpers

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown, limit: number): string {
  if (typeof value === 'number') {
    return String(value);
  }
  if (typeof value !== 'string') {
    return '';
  }
  return value.length > limit ? value.slice(0, limit) : value;
}

function strOrNull(value: unknown, limit: number): string | null {
  const text = str(value, limit);
  return text ? text : null;
}

function nonNegativeInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

function isoOr(value: unknown, fallback: string): string {
  if (value instanceof Date) {
    return value.toISOString().replace(/\.\d{3}Z$/, 'Z');
  }
  return typeof value === 'string' && value ? value : fallback;
}

function stringList(value: unknown, limit: number, each: number): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === 'string' || typeof item === 'number') {
      out.push(String(item).slice(0, each));
    }
    if (out.length >= limit) {
      break;
    }
  }
  return out;
}

function parseAnchorField(value: unknown): EditionAnchor {
  const raw = isPlainObject(value) ? value : {};
  const blocks = nonNegativeInt(raw.blocks);
  return {
    exact: str(raw.exact, EDITION_CAPS.anchorExact),
    block: str(raw.block, 64),
    line: nonNegativeInt(raw.line),
    prefix: str(raw.prefix, EDITION_CAPS.anchorContext),
    suffix: str(raw.suffix, EDITION_CAPS.anchorContext),
    offset: nonNegativeInt(raw.offset) ?? 0,
    blocks: Math.min(EDITION_CAPS.anchorBlocks, Math.max(1, blocks ?? 1)),
  };
}

function parseSections(value: unknown): EditionSection[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: EditionSection[] = [];
  for (let i = 0; i < value.length && out.length < EDITION_CAPS.sections; i++) {
    const raw = value[i];
    if (!isPlainObject(raw)) {
      continue;
    }
    const heading = str(raw.heading, EDITION_CAPS.heading);
    if (!heading) {
      continue;
    }
    const n = nonNegativeInt(raw.n);
    const level = nonNegativeInt(raw.level);
    const status =
      typeof raw.status === 'string' &&
      (RETELL_SECTION_STATUSES as readonly string[]).includes(raw.status)
        ? (raw.status as RetellSectionStatus)
        : 'queued';
    out.push({
      n: n && n > 0 ? n : out.length + 1,
      heading,
      level: level && level >= 1 && level <= 6 ? level : 2,
      line: Math.max(1, nonNegativeInt(raw.line) ?? 1),
      endLine: Math.max(1, nonNegativeInt(raw.endLine) ?? 1),
      words: nonNegativeInt(raw.words) ?? 0,
      codeWords: nonNegativeInt(raw.codeWords) ?? 0,
      tableWords: nonNegativeInt(raw.tableWords) ?? 0,
      hash: str(raw.hash, EDITION_CAPS.hash),
      status,
      actual: nonNegativeInt(raw.actual),
      flagged: stringList(raw.flagged, EDITION_CAPS.flagged, EDITION_CAPS.flag),
      ms: nonNegativeInt(raw.ms),
      anchor: parseAnchorField(raw.anchor),
    });
  }
  return out;
}

function parseDocumentField(value: unknown): EditionDocument {
  const raw = isPlainObject(value) ? value : {};
  const git = isPlainObject(raw.git) ? raw.git : {};
  return {
    workspace: str(raw.workspace, 400),
    path: str(raw.path, 2000),
    absolute: str(raw.absolute, 4000),
    title: str(raw.title, EDITION_CAPS.title),
    headings: stringList(
      raw.headings,
      EDITION_CAPS.headingLevels,
      EDITION_CAPS.headingLevel,
    ),
    words: nonNegativeInt(raw.words) ?? 0,
    git: { remote: str(git.remote, 400), commit: str(git.commit, 64) },
  };
}

function parseEstimateField(value: unknown): EditionEstimate {
  const raw = isPlainObject(value) ? value : {};
  return {
    sourceWords: nonNegativeInt(raw.sourceWords) ?? 0,
    words: nonNegativeInt(raw.words) ?? 0,
    minutes: nonNegativeInt(raw.minutes) ?? 0,
    ceiling: nonNegativeInt(raw.ceiling) ?? 0,
  };
}

export const KNOWN_EDITION_FRONT_KEYS = new Set([
  'id',
  'created',
  'updated',
  'finished',
  'status',
  'stoppedAt',
  'error',
  'shape',
  'scope',
  'engine',
  'estimate',
  'document',
  'sections',
]);

// -------------------------------------------------------------------- parse

/**
 * §10.3 — split the front matter, parse and validate it, keep the body as a
 * string. Unreadable when there is no front matter, the YAML does not parse,
 * or `id` or `status` is missing.
 */
export function parseEditionFile(
  text: string,
): ParsedEdition | EditionParseError {
  if (typeof text !== 'string') {
    return { error: 'not text' };
  }
  const source = text.replace(/\r\n?/g, '\n');
  if (!source.startsWith('---\n')) {
    return { error: 'no front matter' };
  }
  const close = source.indexOf('\n---', 4);
  if (close < 0) {
    return { error: 'front matter is not closed' };
  }
  const fenceEnd = close + 4;
  if (fenceEnd < source.length && source[fenceEnd] !== '\n') {
    return { error: 'front matter is not closed' };
  }
  const yamlText = source.slice(4, close + 1);
  const body = source
    .slice(Math.min(source.length, fenceEnd + 1))
    .replace(/^\n+/, '');
  let front: unknown;
  try {
    front = parseYaml(yamlText);
  } catch (error) {
    return {
      error: `front matter does not parse: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (!isPlainObject(front)) {
    return { error: 'front matter is not a mapping' };
  }
  const id = typeof front.id === 'string' ? front.id.trim() : '';
  if (!EDITION_ID_RE.test(id)) {
    return { error: 'no edition id' };
  }
  const status = front.status;
  if (
    typeof status !== 'string' ||
    !(RETELL_STATUSES as readonly string[]).includes(status)
  ) {
    return { error: 'no status' };
  }
  const engineRaw = isPlainObject(front.engine) ? front.engine : {};
  const unknown: Record<string, unknown> = {};
  for (const key of Object.keys(front)) {
    if (!KNOWN_EDITION_FRONT_KEYS.has(key)) {
      unknown[key] = front[key];
    }
  }
  const created = isoOr(front.created, '');
  const shape =
    typeof front.shape === 'string' &&
    (RETELL_SHAPES as readonly string[]).includes(front.shape)
      ? front.shape
      : DEFAULT_RETELL_SHAPE;
  const scope =
    typeof front.scope === 'string' &&
    (RETELL_SCOPES as readonly string[]).includes(front.scope)
      ? (front.scope as RetellScope)
      : 'selection';
  return {
    id,
    created,
    updated: isoOr(front.updated, created),
    finished: isoOr(front.finished, '') || null,
    status: status as RetellStatus,
    stoppedAt: nonNegativeInt(front.stoppedAt),
    error: strOrNull(front.error, EDITION_CAPS.error),
    shape,
    scope,
    engine: {
      engine: str(engineRaw.engine, 40),
      model: str(engineRaw.model, 120),
      effort: str(engineRaw.effort, 40),
      prompt: nonNegativeInt(engineRaw.prompt) ?? 0,
    },
    estimate: parseEstimateField(front.estimate),
    document: parseDocumentField(front.document),
    sections: parseSections(front.sections),
    unknown,
    body: body.replace(/\s+$/, '') + (body.trim() ? '\n' : ''),
  };
}

// ---------------------------------------------------------------- serialize

function frontMatterObject(edition: ParsedEdition): Record<string, unknown> {
  const front: Record<string, unknown> = {
    id: edition.id,
    created: edition.created,
    updated: edition.updated,
    finished: edition.finished,
    status: edition.status,
    stoppedAt: edition.stoppedAt,
    error: edition.error,
    shape: edition.shape,
    scope: edition.scope,
    engine: {
      engine: edition.engine.engine,
      model: edition.engine.model,
      effort: edition.engine.effort,
      prompt: edition.engine.prompt,
    },
    estimate: {
      sourceWords: edition.estimate.sourceWords,
      words: edition.estimate.words,
      minutes: edition.estimate.minutes,
      ceiling: edition.estimate.ceiling,
    },
    document: {
      workspace: edition.document.workspace,
      path: edition.document.path,
      absolute: edition.document.absolute,
      title: edition.document.title,
      headings: edition.document.headings.slice(),
      words: edition.document.words,
      git: {
        remote: edition.document.git.remote,
        commit: edition.document.git.commit,
      },
    },
    sections: edition.sections.map((section) => ({
      n: section.n,
      heading: section.heading,
      level: section.level,
      line: section.line,
      endLine: section.endLine,
      words: section.words,
      codeWords: section.codeWords,
      tableWords: section.tableWords,
      hash: section.hash,
      status: section.status,
      actual: section.actual,
      flagged: section.flagged.slice(),
      ms: section.ms,
      anchor: {
        exact: section.anchor.exact,
        block: section.anchor.block,
        line: section.anchor.line,
        prefix: section.anchor.prefix,
        suffix: section.anchor.suffix,
        offset: section.anchor.offset,
        blocks: section.anchor.blocks,
      },
    })),
  };
  for (const key of Object.keys(edition.unknown)) {
    if (!KNOWN_EDITION_FRONT_KEYS.has(key)) {
      front[key] = edition.unknown[key];
    }
  }
  return front;
}

/** §10.3 — the inverse of {@link parseEditionFile}, deterministic. */
export function serializeEditionFile(edition: ParsedEdition): string {
  const yaml = stringifyYaml(frontMatterObject(edition), {
    indent: 2,
    lineWidth: 0,
    singleQuote: false,
    defaultStringType: 'PLAIN',
  }).replace(/\n$/, '');
  const body = edition.body.replace(/\s+$/, '');
  return `---\n${yaml}\n---\n\n${body}\n`;
}

// ------------------------------------------------------------------ the body

function curly(text: string): string {
  return text.replace(/\s+/g, ' ').trim().replace(/"/g, '”');
}

/**
 * §10.2 — the `h1`: `"{heading}": the spoken edition` for one section in
 * selection scope, `{document title}: the spoken edition` for a document-scope
 * edition or several sections.
 */
export function editionTitle(
  documentTitle: string,
  sections: { heading: string }[],
  scope: RetellScope,
): string {
  const title = curly(documentTitle) || 'Document';
  if (scope !== 'document' && sections.length === 1) {
    return `"${curly(sections[0].heading)}": the spoken edition`;
  }
  return `${title}: the spoken edition`;
}

/**
 * §10.2 — the frame: the `h1` and the _You were reading_ paragraph, written
 * by the codec at Build and never by the engine.
 */
export function frameFor(
  edition: Pick<ParsedEdition, 'document' | 'sections' | 'scope'>,
): string {
  const title = editionTitle(
    edition.document.title,
    edition.sections,
    edition.scope,
  );
  const document = curly(edition.document.title) || 'the document';
  const where =
    edition.scope !== 'document' && edition.sections.length === 1
      ? `You were reading "${document}", section "${curly(edition.sections[0].heading)}". This is its spoken edition: the same content, in the same order, said to be heard.`
      : `You were reading "${document}". This is its spoken edition, section by section: the same content, in the same order, said to be heard.`;
  return `# ${title}\n\n${where}\n`;
}

/** §9.5 — the body at Build: the frame. */
export function initialBody(
  edition: Pick<ParsedEdition, 'document' | 'sections' | 'scope'>,
): string {
  return frameFor(edition);
}

/**
 * §12.4 — one unit's back link: the source document as a path relative to the
 * edition's own folder, at the unit's heading line (one-based, as
 * `data-source-line` is).
 */
export function backLinkFor(
  edition: Pick<ParsedEdition, 'document'>,
  unit: { line: number | null },
  editionDir: string,
): string {
  return backLink(
    { absolute: edition.document.absolute, line: unit.line },
    editionDir,
    BACK_LINK_TEXT,
  );
}

/** §9.5 — append one unit: two newlines, the markdown, its back link. Append only. */
export function appendSection(
  body: string,
  sectionMarkdown: string,
  backLinkMarkdown: string,
): string {
  return `${body.replace(/\s+$/, '')}\n\n${sectionMarkdown.trim()}\n\n${backLinkMarkdown}\n`;
}

/**
 * §9.8 — a section written by a Rebuild goes back in its place, not at the
 * end: the body is split at the done sections' headings and put together
 * again with the new markdown where its section sits, every part followed by
 * its own back link. Sections still to come are not in the body yet, so a
 * section with no done section after it is a plain append (the first build's
 * path). When a done section's part cannot be found the body is left as it
 * is and the section appended, so nothing written is lost.
 */
export function placeSection(
  body: string,
  sections: { heading: string; level: number; status: string; n: number }[],
  n: number,
  sectionMarkdown: string,
  backLinkOf: (index: number) => string,
): string {
  const index = sections.findIndex((section) => section.n === n);
  if (index < 0) {
    return appendSection(body, sectionMarkdown, backLinkOf(sections.length));
  }
  const laterDone = sections.some(
    (section, i) => i > index && section.status === 'done',
  );
  if (!laterDone) {
    return appendSection(body, sectionMarkdown, backLinkOf(index));
  }
  const split = splitBody(body, sections);
  const lost = sections.some(
    (section, i) =>
      i !== index && section.status === 'done' && split.parts[i] === null,
  );
  if (lost) {
    return appendSection(body, sectionMarkdown, backLinkOf(index));
  }
  let out = split.frame;
  for (let i = 0; i < sections.length; i++) {
    const part = i === index ? sectionMarkdown : split.parts[i];
    if (part !== null) {
      out = appendSection(out, part, backLinkOf(i));
    }
  }
  return out;
}

/**
 * §10.2, D18 — the preamble unit (the text under the `h1`, level 1) is
 * written one level deeper, so the file has exactly one `h1`: the frame's.
 * Every other unit keeps the source's own level.
 */
export function writtenLevelOffset(section: { level: number }): number {
  return section.level <= 1 ? 1 : 0;
}

/** The level a unit's heading is written at. */
export function writtenLevelOf(section: { level: number }): number {
  return Math.min(6, section.level + writtenLevelOffset(section));
}

/** Heading text as it is compared: emphasis markers off, whitespace flat, case folded. */
export function normaliseHeadingText(text: string): string {
  return text
    .replace(/[*_`]/g, '')
    .replace(/\s+#+\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** The `## ` headings of the body outside fences, in order: the units written. */
export function sectionHeadingsIn(body: string): string[] {
  const { prose } = maskFences(body);
  const out: string[] = [];
  for (const line of prose.split('\n')) {
    const match = /^## (\S.*)$/.exec(line);
    if (match) {
      out.push(match[1].replace(/\s+#+\s*$/, '').trim());
    }
  }
  return out;
}

const BACK_LINK_LINE_RE = /^\[[^\]\n]+\]\((?:file:|\.{1,2}\/)[^)\n]*\)\s*$/;

/**
 * §9.8 — Rebuild reuses what was written: the frame (everything before the
 * first unit heading) and, per done section, its markdown from its heading
 * line to the line before the next section's heading, the trailing back link
 * removed. `null` for a section that is not done or whose heading line is
 * not in the body.
 */
export function splitBody(
  body: string,
  sections: { heading: string; level: number; status: string }[],
): { frame: string; parts: (string | null)[] } {
  const text = body.replace(/\r\n?/g, '\n');
  const lines = text.split('\n');
  // `maskFences` drops lines, so the fenced regions are flagged by line
  // instead and the original line numbers stay usable.
  const fenced = fencedLineFlags(lines);
  const found: (number | null)[] = [];
  let cursor = 0;
  for (const section of sections) {
    if (section.status !== 'done') {
      found.push(null);
      continue;
    }
    const level = writtenLevelOf(section);
    const wanted = normaliseHeadingText(section.heading);
    let at: number | null = null;
    for (let i = cursor; i < lines.length; i++) {
      if (fenced[i]) {
        continue;
      }
      const match = /^(#{1,6})\s+(.*?)\s*$/.exec(lines[i]);
      if (!match || match[1].length !== level) {
        continue;
      }
      if (normaliseHeadingText(match[2]) === wanted) {
        at = i;
        break;
      }
    }
    found.push(at);
    if (at !== null) {
      cursor = at + 1;
    }
  }
  const starts = found.filter((at): at is number => at !== null);
  const firstStart = starts.length ? starts[0] : lines.length;
  const frame = lines.slice(0, firstStart).join('\n').replace(/\s+$/, '');
  const parts: (string | null)[] = found.map((at, index) => {
    if (at === null) {
      return null;
    }
    let end = lines.length;
    for (let j = index + 1; j < found.length; j++) {
      const next = found[j];
      if (next !== null) {
        end = next;
        break;
      }
    }
    const slice = lines.slice(at, end);
    while (slice.length && slice[slice.length - 1].trim() === '') {
      slice.pop();
    }
    if (slice.length && BACK_LINK_LINE_RE.test(slice[slice.length - 1])) {
      slice.pop();
    }
    return slice.join('\n').replace(/\s+$/, '');
  });
  return { frame, parts };
}

/** Which lines sit inside a fenced block (the fence lines included). */
function fencedLineFlags(lines: string[]): boolean[] {
  const flags: boolean[] = new Array(lines.length).fill(false);
  let open: { marker: string; length: number } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const match = /^\s*(`{3,}|~{3,})/.exec(lines[i]);
    if (open) {
      flags[i] = true;
      if (
        match &&
        match[1][0] === open.marker &&
        match[1].length >= open.length &&
        lines[i].trim() === match[1]
      ) {
        open = null;
      }
      continue;
    }
    if (match) {
      open = { marker: match[1][0], length: match[1].length };
      flags[i] = true;
    }
  }
  return flags;
}

/** The edition's title: the body's `h1`, else the one the codec would write. */
export function titleOf(edition: ParsedEdition): string {
  const match = /^# (.+)$/m.exec(edition.body);
  if (match) {
    return match[1].trim();
  }
  return editionTitle(edition.document.title, edition.sections, edition.scope);
}

/** §7 — the minutes at 142 words a minute over the units' actual counts. */
export function minutesOf(edition: Pick<ParsedEdition, 'sections'>): number {
  const words = edition.sections.reduce(
    (sum, section) => sum + (section.actual ?? 0),
    0,
  );
  return words > 0 ? minutesFor(words) : 0;
}

/** §14.3 — the units' states for a progress message or an edition preview's config. */
export function unitStates(
  edition: Pick<ParsedEdition, 'sections'>,
  cached?: Set<number>,
): RetellSectionState[] {
  return edition.sections.map((section) => ({
    n: section.n,
    heading: section.heading,
    status: section.status,
    flagged: section.flagged.slice(),
    cached: cached ? cached.has(section.n) : false,
  }));
}

/** §10.3 — what the quick pick, the rows and the marker show. */
export function previewSummary(edition: ParsedEdition): EditionSummary {
  return {
    id: edition.id,
    title: titleOf(edition),
    created: edition.created,
    status: edition.status,
    sections: edition.sections.length,
    done: edition.sections.filter((section) => section.status === 'done')
      .length,
    minutes: minutesOf(edition),
    anchors: edition.sections.map((section) => ({ ...section.anchor })),
    headings: edition.document.headings.slice(),
    documentTitle: edition.document.title,
    unitHeadings: edition.sections.map((section) => section.heading),
  };
}
