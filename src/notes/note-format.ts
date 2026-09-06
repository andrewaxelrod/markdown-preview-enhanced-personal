import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

/**
 * The note file codec (`featrues/12-notes/spec.md` §6).
 *
 * One markdown file per note: YAML front matter for every machine field, then
 * a body in a fixed order — `# title`, the passage as a blockquote, the
 * generated sections, `## My note`, `## Context`. Pure module: no `vscode`, no
 * I/O, so `parse(serialize(x))` and `serialize(parse(t))` are unit-testable.
 *
 * Everything copied from the document (passage, enclosing, before, after) is
 * written inside blockquotes, so a passage that begins with `#` or `---` can
 * never be read back as structure (§6.2).
 */

// ------------------------------------------------------------------- caps

/** The same caps as `messages.ts` (§14.2), applied to a hand-edited file too. */
export const NOTE_CAPS = {
  exact: 6000,
  prefix: 64,
  suffix: 64,
  blocks: 50,
  title: 120,
  myNote: 20000,
  tags: 12,
  tag: 32,
  headingLevels: 6,
  headingLevel: 200,
  documentTitle: 200,
  context: 12000,
} as const;

export const NOTE_ID_RE = /^\d{8}T\d{6}Z-[0-9a-f]{4}$/;
export const NOTE_BLOCK_KEY_RE = /^b[0-9a-f]{1,8}$/;
export const NOTE_TAG_RE = /^[a-z0-9][a-z0-9-]*$/;

// ---------------------------------------------------------------- sections

/** The section headings the codec knows, in the body's fixed order (§6.2). */
export const NOTE_SECTION_ORDER = [
  'Summary',
  'Why it matters',
  'What it means here',
  'In general',
  'Terms',
  'Explanation',
] as const;
export type NoteSectionName = (typeof NOTE_SECTION_ORDER)[number];

/** The sections a generation writes; `Explanation` is help's and is kept. */
export const GENERATED_SECTION_NAMES: readonly NoteSectionName[] = [
  'Summary',
  'Why it matters',
  'What it means here',
  'In general',
  'Terms',
];

export const MY_NOTE_HEADING = 'My note';
export const CONTEXT_HEADING = 'Context';

/** Case-insensitive, trailing colon tolerated → the canonical name, or null. */
export function canonicalSectionName(heading: string): NoteSectionName | null {
  const key = heading.trim().replace(/:$/, '').trim().toLowerCase();
  for (const name of NOTE_SECTION_ORDER) {
    if (name.toLowerCase() === key) {
      return name;
    }
  }
  return null;
}

// ------------------------------------------------------------------- types

export type NoteShape = 'passage' | 'term';
export type NoteGeneratedStatus = 'pending' | 'done' | 'error';
export type NoteGeneratedSource = 'engine' | 'help';

export interface NoteDocument {
  workspace: string;
  path: string;
  absolute: string;
  title: string;
  headings: string[];
  git: { remote: string; commit: string };
}

export interface NoteAnchorPosition {
  block: string;
  line: number | null;
}

export interface NoteAnchor {
  block: string;
  line: number | null;
  exact: string;
  prefix: string;
  suffix: string;
  offset: number;
  blocks: number;
  lastSeen?: string;
  missingSince?: string;
  /** Where the note was last found when that differs from `block` (§9.1). */
  current?: NoteAnchorPosition;
  /** The captured anchor, kept once _Re-attach_ has moved `current` (§11.3). */
  original?: NoteAnchorPosition;
}

export interface NoteGenerated {
  status: NoteGeneratedStatus;
  source?: NoteGeneratedSource;
  engine?: string;
  model?: string;
  effort?: string;
  prompt?: number;
  at?: string;
  /** The mapped one-line reason when `status` is `error` (§5.2 step 4). */
  error?: string;
}

export interface NoteContext {
  enclosing: string;
  before: string;
  after: string;
}

export interface NoteExtraSection {
  heading: string;
  markdown: string;
}

export interface ParsedNote {
  id: string;
  created: string;
  updated: string;
  shape: NoteShape;
  titleEdited: boolean;
  document: NoteDocument;
  anchor: NoteAnchor;
  generated: NoteGenerated;
  tags: string[];
  /** Front-matter keys the codec does not know, written back unchanged. */
  unknown: Record<string, unknown>;
  title: string;
  passage: string;
  /** The known generated sections present in the file, by canonical name. */
  sections: Map<NoteSectionName, string>;
  /** Other `h2` sections of the generated region, in their captured order. */
  extras: NoteExtraSection[];
  myNote: string;
  context: NoteContext;
}

export interface NoteParseError {
  error: string;
}

export function isParseError(
  value: ParsedNote | NoteParseError,
): value is NoteParseError {
  return typeof (value as NoteParseError).error === 'string';
}

// ----------------------------------------------------------------- helpers

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown, limit: number): string {
  if (typeof value !== 'string') {
    return '';
  }
  return value.length > limit ? value.slice(0, limit) : value;
}

function nonNegativeInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

function isoOr(value: unknown, fallback: string): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  return typeof value === 'string' && value ? value : fallback;
}

/**
 * One tag as the file stores it: lower-cased, spaces to hyphens, anything
 * outside `[a-z0-9-]` dropped, capped, and only when it still matches the
 * tag shape. `null` when nothing is left.
 */
export function normaliseTag(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const tag = value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, NOTE_CAPS.tag);
  return tag && NOTE_TAG_RE.test(tag) ? tag : null;
}

/** At most twelve distinct normalised tags, in order. */
export function normaliseTags(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: string[] = [];
  for (const raw of value) {
    const tag = normaliseTag(raw);
    if (tag && !out.includes(tag)) {
      out.push(tag);
      if (out.length >= NOTE_CAPS.tags) {
        break;
      }
    }
  }
  return out;
}

function parsePosition(value: unknown): NoteAnchorPosition | undefined {
  if (!isPlainObject(value)) {
    return undefined;
  }
  const block = str(value.block, 64);
  if (!NOTE_BLOCK_KEY_RE.test(block)) {
    return undefined;
  }
  const line = nonNegativeInt(value.line);
  return { block, line };
}

function parseAnchor(value: unknown): NoteAnchor {
  const raw = isPlainObject(value) ? value : {};
  const block = str(raw.block, 64);
  const blocksRaw = nonNegativeInt(raw.blocks);
  const anchor: NoteAnchor = {
    block: NOTE_BLOCK_KEY_RE.test(block) ? block : '',
    line: nonNegativeInt(raw.line),
    exact: str(raw.exact, NOTE_CAPS.exact),
    prefix: str(raw.prefix, NOTE_CAPS.prefix),
    suffix: str(raw.suffix, NOTE_CAPS.suffix),
    offset: nonNegativeInt(raw.offset) ?? 0,
    blocks: Math.min(NOTE_CAPS.blocks, Math.max(1, blocksRaw ?? 1)),
  };
  if (typeof raw.lastSeen === 'string' && raw.lastSeen) {
    anchor.lastSeen = raw.lastSeen;
  } else if (raw.lastSeen instanceof Date) {
    anchor.lastSeen = raw.lastSeen.toISOString();
  }
  if (typeof raw.missingSince === 'string' && raw.missingSince) {
    anchor.missingSince = raw.missingSince;
  } else if (raw.missingSince instanceof Date) {
    anchor.missingSince = raw.missingSince.toISOString();
  }
  const current = parsePosition(raw.current);
  if (current) {
    anchor.current = current;
  }
  const original = parsePosition(raw.original);
  if (original) {
    anchor.original = original;
  }
  return anchor;
}

function parseGenerated(value: unknown): NoteGenerated {
  const raw = isPlainObject(value) ? value : {};
  const status =
    raw.status === 'done' || raw.status === 'error' || raw.status === 'pending'
      ? raw.status
      : 'pending';
  const generated: NoteGenerated = { status };
  if (raw.source === 'engine' || raw.source === 'help') {
    generated.source = raw.source;
  }
  for (const key of ['engine', 'model', 'effort', 'error'] as const) {
    const text = str(raw[key], 400);
    if (text) {
      generated[key] = text;
    }
  }
  const prompt = nonNegativeInt(raw.prompt);
  if (prompt !== null) {
    generated.prompt = prompt;
  }
  const at = isoOr(raw.at, '');
  if (at) {
    generated.at = at;
  }
  return generated;
}

function parseDocument(value: unknown): NoteDocument {
  const raw = isPlainObject(value) ? value : {};
  const headings: string[] = [];
  if (Array.isArray(raw.headings)) {
    for (const level of raw.headings) {
      if (typeof level === 'string' || typeof level === 'number') {
        headings.push(String(level).slice(0, NOTE_CAPS.headingLevel));
      }
      if (headings.length >= NOTE_CAPS.headingLevels) {
        break;
      }
    }
  }
  const git = isPlainObject(raw.git) ? raw.git : {};
  return {
    workspace: str(raw.workspace, 400),
    path: str(raw.path, 2000),
    absolute: str(raw.absolute, 4000),
    title: str(raw.title, NOTE_CAPS.documentTitle),
    headings,
    git: {
      remote: str(git.remote, 400),
      commit: str(git.commit, 64),
    },
  };
}

const KNOWN_FRONT_KEYS = new Set([
  'id',
  'created',
  'updated',
  'shape',
  'titleEdited',
  'document',
  'anchor',
  'generated',
  'tags',
]);

// ------------------------------------------------------------- blockquotes

/** Every line prefixed `> ` (a bare `>` for an empty line). */
export function toBlockquote(text: string): string {
  return text
    .split('\n')
    .map((line) => (line.length ? `> ${line}` : '>'))
    .join('\n');
}

/**
 * The text of a run of blockquote lines: the leading `>` and one optional
 * space stripped from each. Lines that are not quoted end the run.
 */
function readBlockquote(
  lines: string[],
  from: number,
): { text: string; next: number } {
  let i = from;
  while (i < lines.length && lines[i].trim() === '') {
    i++;
  }
  const out: string[] = [];
  while (i < lines.length && /^>/.test(lines[i])) {
    out.push(lines[i].replace(/^> ?/, ''));
    i++;
  }
  return { text: out.join('\n'), next: i };
}

/** Surrounding blank lines dropped, inner lines kept verbatim. */
function trimBlankLines(lines: string[]): string {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start].trim() === '') {
    start++;
  }
  while (end > start && lines[end - 1].trim() === '') {
    end--;
  }
  return lines.slice(start, end).join('\n');
}

function isH2(line: string): boolean {
  return /^## \S/.test(line) || /^##\s*$/.test(line);
}

function h2Text(line: string): string {
  return line.replace(/^##\s*/, '').trim();
}

// ------------------------------------------------------------------- parse

/**
 * §6.3 — split the front matter, parse it, validate what is known, and read
 * the body by the rules of §6.2. A file with no fence, unparsable YAML, no
 * `id` or no `h1` is **unreadable**: the store lists it as such and never
 * writes to it.
 */
export function parseNoteFile(text: string): ParsedNote | NoteParseError {
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
  const bodyText = source.slice(Math.min(source.length, fenceEnd + 1));

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
  if (!NOTE_ID_RE.test(id)) {
    return { error: 'no note id' };
  }

  const lines = bodyText.split('\n');
  let i = 0;
  let title = '';
  let sawTitle = false;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (/^# \S/.test(line)) {
      title = line.replace(/^#\s+/, '').trim().slice(0, NOTE_CAPS.title);
      sawTitle = true;
      i++;
      break;
    }
    if (line.trim() !== '') {
      // Prose before the h1 is not the shape the store writes.
      break;
    }
  }
  if (!sawTitle) {
    return { error: 'no title' };
  }

  const passage = readBlockquote(lines, i);
  i = passage.next;

  // The generated region: from here to `## My note`.
  const sections = new Map<NoteSectionName, string>();
  const extras: NoteExtraSection[] = [];
  let myNote = '';
  let context: NoteContext = { enclosing: '', before: '', after: '' };
  let heading: string | null = null;
  let buffer: string[] = [];
  let region: 'generated' | 'mine' | 'context' = 'generated';

  const flush = () => {
    if (region === 'generated') {
      if (heading === null) {
        return;
      }
      const markdown = trimBlankLines(buffer);
      const name = canonicalSectionName(heading);
      if (name) {
        sections.set(name, markdown);
      } else {
        extras.push({ heading, markdown });
      }
    } else if (region === 'mine') {
      myNote = trimBlankLines(buffer).slice(0, NOTE_CAPS.myNote);
    } else {
      context = parseContext(buffer);
    }
    buffer = [];
  };

  for (; i < lines.length; i++) {
    const line = lines[i];
    if (isH2(line)) {
      const name = h2Text(line);
      const lower = name.replace(/:$/, '').trim().toLowerCase();
      if (region !== 'context' && lower === MY_NOTE_HEADING.toLowerCase()) {
        flush();
        region = 'mine';
        heading = name;
        continue;
      }
      if (region !== 'context' && lower === CONTEXT_HEADING.toLowerCase()) {
        flush();
        region = 'context';
        heading = name;
        continue;
      }
      if (region === 'generated') {
        flush();
        heading = name;
        continue;
      }
    }
    if (region === 'generated' && heading === null) {
      // Loose prose between the passage and the first h2 belongs to no
      // section; the store never writes any, so it is dropped.
      continue;
    }
    buffer.push(line);
  }
  flush();

  const tags = normaliseTags(front.tags);
  const unknown: Record<string, unknown> = {};
  for (const key of Object.keys(front)) {
    if (!KNOWN_FRONT_KEYS.has(key)) {
      unknown[key] = front[key];
    }
  }

  const created = isoOr(front.created, '');
  return {
    id,
    created,
    updated: isoOr(front.updated, created),
    shape: front.shape === 'term' ? 'term' : 'passage',
    titleEdited: front.titleEdited === true,
    document: parseDocument(front.document),
    anchor: parseAnchor(front.anchor),
    generated: parseGenerated(front.generated),
    tags,
    unknown,
    title,
    passage: passage.text.slice(0, NOTE_CAPS.exact),
    sections,
    extras,
    myNote,
    context,
  };
}

const CONTEXT_LABELS: Record<string, keyof NoteContext> = {
  enclosing: 'enclosing',
  before: 'before',
  after: 'after',
};

/** `**Enclosing**`, `**Before**`, `**After**`, each followed by a blockquote. */
function parseContext(lines: string[]): NoteContext {
  const out: NoteContext = { enclosing: '', before: '', after: '' };
  let i = 0;
  while (i < lines.length) {
    const match = /^\*\*([A-Za-z]+)\*\*\s*$/.exec(lines[i].trim());
    if (match) {
      const key = CONTEXT_LABELS[match[1].toLowerCase()];
      const quote = readBlockquote(lines, i + 1);
      if (key) {
        out[key] = quote.text.slice(0, NOTE_CAPS.context);
      }
      i = quote.next > i + 1 ? quote.next : i + 1;
      continue;
    }
    i++;
  }
  return out;
}

// --------------------------------------------------------------- serialize

function frontMatterObject(note: ParsedNote): Record<string, unknown> {
  const anchor: Record<string, unknown> = {
    block: note.anchor.block,
    line: note.anchor.line,
    exact: note.anchor.exact,
    prefix: note.anchor.prefix,
    suffix: note.anchor.suffix,
    offset: note.anchor.offset,
    blocks: note.anchor.blocks,
  };
  if (note.anchor.lastSeen) {
    anchor.lastSeen = note.anchor.lastSeen;
  }
  if (note.anchor.missingSince) {
    anchor.missingSince = note.anchor.missingSince;
  }
  if (note.anchor.current) {
    anchor.current = {
      block: note.anchor.current.block,
      line: note.anchor.current.line,
    };
  }
  if (note.anchor.original) {
    anchor.original = {
      block: note.anchor.original.block,
      line: note.anchor.original.line,
    };
  }
  const generated: Record<string, unknown> = { status: note.generated.status };
  for (const key of [
    'source',
    'engine',
    'model',
    'effort',
    'prompt',
    'at',
    'error',
  ] as const) {
    const value = note.generated[key];
    if (value !== undefined && value !== '') {
      generated[key] = value;
    }
  }
  const front: Record<string, unknown> = {
    id: note.id,
    created: note.created,
    updated: note.updated,
    shape: note.shape,
  };
  if (note.titleEdited) {
    front.titleEdited = true;
  }
  front.document = {
    workspace: note.document.workspace,
    path: note.document.path,
    absolute: note.document.absolute,
    title: note.document.title,
    headings: note.document.headings.slice(),
    git: {
      remote: note.document.git.remote,
      commit: note.document.git.commit,
    },
  };
  front.anchor = anchor;
  front.generated = generated;
  front.tags = note.tags.slice();
  for (const key of Object.keys(note.unknown)) {
    if (!KNOWN_FRONT_KEYS.has(key)) {
      front[key] = note.unknown[key];
    }
  }
  return front;
}

function serializeFrontMatter(note: ParsedNote): string {
  return stringifyYaml(frontMatterObject(note), {
    indent: 2,
    lineWidth: 0,
    singleQuote: false,
    // Dates are strings already; never let the scalar resolver turn them back.
    defaultStringType: 'PLAIN',
  }).replace(/\n$/, '');
}

/** The generated sections in the fixed order, then the extras (§6.2). */
export function generatedSectionsInOrder(
  note: Pick<ParsedNote, 'sections' | 'extras'>,
): { heading: string; markdown: string }[] {
  const out: { heading: string; markdown: string }[] = [];
  for (const name of NOTE_SECTION_ORDER) {
    if (note.sections.has(name)) {
      out.push({ heading: name, markdown: note.sections.get(name) ?? '' });
    }
  }
  for (const extra of note.extras) {
    out.push({ heading: extra.heading, markdown: extra.markdown });
  }
  return out;
}

/** The body from the `h1` to `## My note`, as markdown. */
export function generatedMarkdown(
  note: Pick<ParsedNote, 'sections' | 'extras'>,
): string {
  const parts: string[] = [];
  for (const section of generatedSectionsInOrder(note)) {
    parts.push(`## ${section.heading}`);
    if (section.markdown) {
      parts.push(section.markdown);
    }
  }
  return parts.join('\n\n');
}

/** §6.3 — the inverse of {@link parseNoteFile}, deterministic. */
export function serializeNoteFile(note: ParsedNote): string {
  const blocks: string[] = [];
  blocks.push(`# ${note.title.replace(/\s+/g, ' ').trim()}`);
  blocks.push(toBlockquote(note.passage));
  for (const section of generatedSectionsInOrder(note)) {
    blocks.push(`## ${section.heading}`);
    if (section.markdown) {
      blocks.push(section.markdown);
    }
  }
  blocks.push(`## ${MY_NOTE_HEADING}`);
  if (note.myNote) {
    blocks.push(note.myNote);
  }
  blocks.push(`## ${CONTEXT_HEADING}`);
  const labels: [string, string][] = [
    ['Enclosing', note.context.enclosing],
    ['Before', note.context.before],
    ['After', note.context.after],
  ];
  for (const [label, value] of labels) {
    if (value) {
      blocks.push(`**${label}**`);
      blocks.push(toBlockquote(value));
    }
  }
  return `---\n${serializeFrontMatter(note)}\n---\n\n${blocks.join('\n\n')}\n`;
}

// ------------------------------------------------------------ generation

/** What a generation yields, as `parseNoteAnswer` in `note-prompt.ts` returns it. */
export interface GeneratedNoteParts {
  title: string;
  /** True when the title was made from the passage, not written by the model. */
  titleFallback: boolean;
  sections: Map<NoteSectionName, string>;
  extras: NoteExtraSection[];
  tags: string[];
}

/**
 * §6.3 — put a generation into a parsed note: the title (unless the reader
 * edited it), the known generated sections and the tags. `## Explanation`,
 * the extras already in the file, _My note_ and _Context_ stay. The caller
 * writes `generated` and `updated`.
 */
export function applyGenerated(
  note: ParsedNote,
  parts: GeneratedNoteParts,
): ParsedNote {
  const sections = new Map<NoteSectionName, string>();
  if (note.sections.has('Explanation')) {
    sections.set('Explanation', note.sections.get('Explanation') ?? '');
  }
  for (const name of GENERATED_SECTION_NAMES) {
    if (parts.sections.has(name)) {
      sections.set(name, parts.sections.get(name) ?? '');
    }
  }
  const extras = note.extras.filter(
    (extra) =>
      !parts.extras.some(
        (fresh) => fresh.heading.toLowerCase() === extra.heading.toLowerCase(),
      ),
  );
  for (const fresh of parts.extras) {
    extras.push({ heading: fresh.heading, markdown: fresh.markdown });
  }
  const title =
    note.titleEdited || (parts.titleFallback && note.title)
      ? note.title
      : parts.title || note.title;
  return {
    ...note,
    title,
    sections,
    extras,
    tags: parts.tags.length ? normaliseTags(parts.tags) : note.tags,
  };
}

// --------------------------------------------------------------- clipboard

/**
 * §11.4 — the `h1`, the passage quote, the generated sections, _My note_
 * when non-empty, then one line naming the document and the heading path.
 * No front matter, no _Context_.
 */
export function noteBodyForClipboard(note: ParsedNote): string {
  const blocks: string[] = [`# ${note.title}`, toBlockquote(note.passage)];
  const generated = generatedMarkdown(note);
  if (generated) {
    blocks.push(generated);
  }
  if (note.myNote) {
    blocks.push(`## ${MY_NOTE_HEADING}`);
    blocks.push(note.myNote);
  }
  const where = [note.document.path, ...note.document.headings]
    .filter((part) => part && part.length)
    .join(' › ');
  blocks.push(`— ${where}`);
  return `${blocks.join('\n\n')}\n`;
}

/** The first eight words of the passage, an ellipsis when cut (§5.4, §8.3). */
export function titleFromPassage(passage: string): string {
  const words = passage.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  const head = words.slice(0, 8).join(' ');
  const title = words.length > 8 ? `${head}…` : head;
  return title.slice(0, NOTE_CAPS.title) || 'Note';
}

/** The first sentence of the summary (or the first section), for the lists. */
export function summaryLineOf(note: Pick<ParsedNote, 'sections'>): string {
  const text =
    note.sections.get('Summary') ??
    note.sections.get('What it means here') ??
    note.sections.get('Explanation') ??
    '';
  const flat = text
    .replace(/^#+\s.*$/gm, '')
    .replace(/[*_`>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!flat) {
    return '';
  }
  const match = /^(.+?[.!?])(\s|$)/.exec(flat);
  return (match ? match[1] : flat).slice(0, 300);
}
