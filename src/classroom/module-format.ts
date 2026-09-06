import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { toBlockquote } from '../notes/note-format';
import { lastParagraph, maskFences } from './checks';
import { emptyLedger, type Ledger } from './ledger';
import type { ClassroomLevel } from './persona';
import {
  CHAPTER_TYPES,
  CLASSROOM_CAPS,
  provisionalTitle,
  type ChapterType,
  type Plan,
  type PlanChapter,
} from './plan-prompt';

/**
 * The module file codec (`featrues/13-classroom/spec.md` §10).
 *
 * One markdown file per module: YAML front matter for the machine part (the
 * plan, the chapters and their states, the ledger, the passage anchor), then
 * a body the build appends to and never rewrites: the frame (`h1`, the _You
 * were reading_ line with its back link, the passage quote), the chapters,
 * the closing back link. The body is kept as a string; the codec knows it
 * only through the `h1` line it rewrites after the plan, the `##` headings it
 * counts for Continue and the closing link it appends at `done`.
 *
 * Pure module: no `vscode`, no I/O.
 */

export const MODULE_STATUSES = [
  'planning',
  'writing',
  'done',
  'stopped',
  'failed',
  'queued',
] as const;
export type ModuleStatus = (typeof MODULE_STATUSES)[number];

export const CHAPTER_STATUSES = [
  'queued',
  'writing',
  'done',
  'failed',
] as const;
export type ChapterStatus = (typeof CHAPTER_STATUSES)[number];

export const MODULE_ID_RE = /^\d{8}T\d{6}Z-[0-9a-f]{4}$/;
export const WORDS_PER_MINUTE = 150;
export const BACK_LINK_TEXT = 'Back to the passage';

export interface ModuleChapter extends PlanChapter {
  status: ChapterStatus;
  /** The written chapter's word count, once done. */
  actual: number | null;
  /** The check codes the second draft still failed (§9.5). */
  flagged: string[];
  /** How long the chapter's calls took. */
  ms: number | null;
}

export interface ModulePersonaRef {
  id: string;
  name: string;
  version: number;
}

export interface ModuleEngine {
  engine: string;
  model: string;
  effort: string;
  /** `CLASSROOM_PROMPT_VERSION` at the time of the build. */
  prompt: number;
}

export interface ModuleLinkedDocument {
  path: string;
  title: string;
  words: number;
}

export interface ModuleDocument {
  workspace: string;
  path: string;
  absolute: string;
  title: string;
  headings: string[];
  headingId: string | null;
  words: number;
  git: { remote: string; commit: string };
  linked: ModuleLinkedDocument[];
}

export interface ModulePassage {
  exact: string;
  block: string;
  line: number | null;
  prefix: string;
  suffix: string;
  offset: number;
  blocks: number;
}

export interface ParsedModule {
  id: string;
  created: string;
  updated: string;
  finished: string | null;
  status: ModuleStatus;
  stoppedAt: number | null;
  error: string | null;
  persona: ModulePersonaRef;
  level: ClassroomLevel;
  readerNote: string;
  audience: string;
  engine: ModuleEngine;
  document: ModuleDocument;
  passage: ModulePassage;
  plan: Plan | null;
  chapters: ModuleChapter[];
  ledger: Ledger;
  /** Front-matter keys the codec does not know, written back unchanged. */
  unknown: Record<string, unknown>;
  /** The markdown after the front matter, verbatim. */
  body: string;
}

export interface ModuleParseError {
  error: string;
}

/**
 * A parse error is an object with only `error`; a parsed module also carries
 * `error` (the build's failure reason, or null), so the test is the absence
 * of `status`, which every module has.
 */
export function isModuleParseError(
  value: ParsedModule | ModuleParseError,
): value is ModuleParseError {
  return (
    !('status' in value) &&
    typeof (value as ModuleParseError).error === 'string'
  );
}

/** §14.3 — what the quick pick and the sheets show for a module. */
export interface ModuleSummary {
  id: string;
  title: string;
  created: string;
  status: ModuleStatus;
  chapters: number;
  done: number;
  minutes: number;
  /** 13 §12.5 — the passage anchor the module was built from, for the marker. */
  anchor: ModulePassage;
  /** The document's heading path above the passage. */
  headings: string[];
  /** The first 160 characters of the exact passage, for tooltips and rows. */
  passage: string;
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

function chapterType(value: unknown): ChapterType {
  return typeof value === 'string' &&
    (CHAPTER_TYPES as readonly string[]).includes(value)
    ? (value as ChapterType)
    : 'concept';
}

function parsePlanChapter(raw: unknown, index: number): PlanChapter | null {
  if (!isPlainObject(raw)) {
    return null;
  }
  const title = str(raw.title, CLASSROOM_CAPS.title);
  if (!title) {
    return null;
  }
  const n = nonNegativeInt(raw.n);
  const words = nonNegativeInt(raw.words) ?? 0;
  return {
    n: n && n > 0 ? n : index + 1,
    title,
    question: str(raw.question, 600),
    type: chapterType(raw.type),
    words,
    drawsOn: stringList(raw.drawsOn, 12, 200),
  };
}

function parsePlanField(value: unknown): Plan | null {
  if (!isPlainObject(value)) {
    return null;
  }
  const title = str(value.title, CLASSROOM_CAPS.title);
  if (!title) {
    return null;
  }
  const chapters: PlanChapter[] = [];
  if (Array.isArray(value.chapters)) {
    for (let i = 0; i < value.chapters.length; i++) {
      const chapter = parsePlanChapter(value.chapters[i], i);
      if (chapter) {
        chapters.push(chapter);
      }
    }
  }
  return {
    title,
    mission: str(value.mission, 1000),
    chapters,
    terms: stringList(value.terms, 40, 120),
    example: str(value.example, 600),
  };
}

function parseChapters(value: unknown): ModuleChapter[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: ModuleChapter[] = [];
  for (let i = 0; i < value.length; i++) {
    const raw = value[i];
    const base = parsePlanChapter(raw, i);
    if (!base || !isPlainObject(raw)) {
      continue;
    }
    const status =
      typeof raw.status === 'string' &&
      (CHAPTER_STATUSES as readonly string[]).includes(raw.status)
        ? (raw.status as ChapterStatus)
        : 'queued';
    out.push({
      ...base,
      status,
      actual: nonNegativeInt(raw.actual),
      flagged: stringList(raw.flagged, 20, 40),
      ms: nonNegativeInt(raw.ms),
    });
  }
  return out;
}

function parseLedgerField(value: unknown): Ledger {
  const ledger = emptyLedger();
  if (!isPlainObject(value)) {
    return ledger;
  }
  if (Array.isArray(value.promises)) {
    for (const raw of value.promises) {
      if (!isPlainObject(raw)) {
        continue;
      }
      const text = str(raw.text, 400);
      if (!text) {
        continue;
      }
      ledger.promises.push({
        text,
        made: nonNegativeInt(raw.made) ?? 0,
        due: nonNegativeInt(raw.due),
        paid: raw.paid === true,
      });
    }
  }
  if (Array.isArray(value.examples)) {
    for (const raw of value.examples) {
      if (!isPlainObject(raw)) {
        continue;
      }
      const name = str(raw.name, 200);
      if (!name) {
        continue;
      }
      const chapters = Array.isArray(raw.chapters)
        ? raw.chapters.filter(
            (n): n is number => typeof n === 'number' && Number.isInteger(n),
          )
        : [];
      ledger.examples.push({
        name,
        standsFor: str(raw.standsFor, 400),
        chapters,
      });
    }
  }
  if (Array.isArray(value.terms)) {
    for (const raw of value.terms) {
      if (!isPlainObject(raw)) {
        continue;
      }
      const term = str(raw.term, 200);
      if (!term) {
        continue;
      }
      ledger.terms.push({
        term,
        gloss: str(raw.gloss, 400),
        chapter: nonNegativeInt(raw.chapter) ?? 0,
      });
    }
  }
  if (Array.isArray(value.analogies)) {
    for (const raw of value.analogies) {
      if (!isPlainObject(raw)) {
        continue;
      }
      const concept = str(raw.concept, 200);
      if (!concept) {
        continue;
      }
      ledger.analogies.push({
        concept,
        analogy: str(raw.analogy, 400),
        chapter: nonNegativeInt(raw.chapter) ?? 0,
      });
    }
  }
  return ledger;
}

function parseDocumentField(value: unknown): ModuleDocument {
  const raw = isPlainObject(value) ? value : {};
  const git = isPlainObject(raw.git) ? raw.git : {};
  const linked: ModuleLinkedDocument[] = [];
  if (Array.isArray(raw.linked)) {
    for (const item of raw.linked) {
      if (!isPlainObject(item)) {
        continue;
      }
      const linkedPath = str(item.path, CLASSROOM_CAPS.linkedPath);
      if (!linkedPath) {
        continue;
      }
      linked.push({
        path: linkedPath,
        title: str(item.title, 200),
        words: nonNegativeInt(item.words) ?? 0,
      });
    }
  }
  return {
    workspace: str(raw.workspace, 400),
    path: str(raw.path, 2000),
    absolute: str(raw.absolute, 4000),
    title: str(raw.title, 200),
    headings: stringList(raw.headings, 6, 200),
    headingId: strOrNull(raw.headingId, CLASSROOM_CAPS.headingId),
    words: nonNegativeInt(raw.words) ?? 0,
    git: { remote: str(git.remote, 400), commit: str(git.commit, 64) },
    linked,
  };
}

function parsePassageField(value: unknown): ModulePassage {
  const raw = isPlainObject(value) ? value : {};
  const blocks = nonNegativeInt(raw.blocks);
  return {
    exact: str(raw.exact, CLASSROOM_CAPS.passage),
    block: str(raw.block, 64),
    line: nonNegativeInt(raw.line),
    prefix: str(raw.prefix, 64),
    suffix: str(raw.suffix, 64),
    offset: nonNegativeInt(raw.offset) ?? 0,
    blocks: Math.min(50, Math.max(1, blocks ?? 1)),
  };
}

const KNOWN_FRONT_KEYS = new Set([
  'id',
  'created',
  'updated',
  'finished',
  'status',
  'stoppedAt',
  'error',
  'persona',
  'level',
  'readerNote',
  'audience',
  'engine',
  'document',
  'passage',
  'plan',
  'chapters',
  'ledger',
]);

// -------------------------------------------------------------------- parse

/**
 * §10.3 — split the front matter, parse and validate it, keep the body as a
 * string. Unreadable when there is no front matter, the YAML does not parse,
 * or `id` or `status` is missing.
 */
export function parseModuleFile(text: string): ParsedModule | ModuleParseError {
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
  if (!MODULE_ID_RE.test(id)) {
    return { error: 'no module id' };
  }
  const status = front.status;
  if (
    typeof status !== 'string' ||
    !(MODULE_STATUSES as readonly string[]).includes(status)
  ) {
    return { error: 'no status' };
  }
  const personaRaw = isPlainObject(front.persona) ? front.persona : {};
  const engineRaw = isPlainObject(front.engine) ? front.engine : {};
  const level = front.level;
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
    finished: isoOr(front.finished, '') || null,
    status: status as ModuleStatus,
    stoppedAt: nonNegativeInt(front.stoppedAt),
    error: strOrNull(front.error, 1000),
    persona: {
      id: str(personaRaw.id, 40) || 'max',
      name: str(personaRaw.name, 80),
      version: nonNegativeInt(personaRaw.version) ?? 1,
    },
    level: level === 1 || level === 2 || level === 3 ? level : 2,
    readerNote: str(front.readerNote, CLASSROOM_CAPS.readerNote),
    audience: str(front.audience, CLASSROOM_CAPS.audience),
    engine: {
      engine: str(engineRaw.engine, 40),
      model: str(engineRaw.model, 120),
      effort: str(engineRaw.effort, 40),
      prompt: nonNegativeInt(engineRaw.prompt) ?? 0,
    },
    document: parseDocumentField(front.document),
    passage: parsePassageField(front.passage),
    plan: parsePlanField(front.plan),
    chapters: parseChapters(front.chapters),
    ledger: parseLedgerField(front.ledger),
    unknown,
    body: body.replace(/\s+$/, '') + (body.trim() ? '\n' : ''),
  };
}

// ---------------------------------------------------------------- serialize

function frontMatterObject(module: ParsedModule): Record<string, unknown> {
  const front: Record<string, unknown> = {
    id: module.id,
    created: module.created,
    updated: module.updated,
    finished: module.finished,
    status: module.status,
    stoppedAt: module.stoppedAt,
    error: module.error,
    persona: {
      id: module.persona.id,
      name: module.persona.name,
      version: module.persona.version,
    },
    level: module.level,
    readerNote: module.readerNote,
    audience: module.audience,
    engine: {
      engine: module.engine.engine,
      model: module.engine.model,
      effort: module.engine.effort,
      prompt: module.engine.prompt,
    },
    document: {
      workspace: module.document.workspace,
      path: module.document.path,
      absolute: module.document.absolute,
      title: module.document.title,
      headings: module.document.headings.slice(),
      headingId: module.document.headingId,
      words: module.document.words,
      git: {
        remote: module.document.git.remote,
        commit: module.document.git.commit,
      },
      linked: module.document.linked.map((linked) => ({
        path: linked.path,
        title: linked.title,
        words: linked.words,
      })),
    },
    passage: {
      exact: module.passage.exact,
      block: module.passage.block,
      line: module.passage.line,
      prefix: module.passage.prefix,
      suffix: module.passage.suffix,
      offset: module.passage.offset,
      blocks: module.passage.blocks,
    },
  };
  if (module.plan) {
    front.plan = {
      title: module.plan.title,
      mission: module.plan.mission,
      terms: module.plan.terms.slice(),
      example: module.plan.example,
    };
    front.chapters = module.chapters.map((chapter) => ({
      n: chapter.n,
      title: chapter.title,
      question: chapter.question,
      type: chapter.type,
      words: chapter.words,
      drawsOn: chapter.drawsOn.slice(),
      status: chapter.status,
      actual: chapter.actual,
      flagged: chapter.flagged.slice(),
      ms: chapter.ms,
    }));
    front.ledger = {
      promises: module.ledger.promises.map((p) => ({
        text: p.text,
        made: p.made,
        due: p.due,
        paid: p.paid,
      })),
      examples: module.ledger.examples.map((e) => ({
        name: e.name,
        standsFor: e.standsFor,
        chapters: e.chapters.slice(),
      })),
      terms: module.ledger.terms.map((t) => ({
        term: t.term,
        gloss: t.gloss,
        chapter: t.chapter,
      })),
      analogies: module.ledger.analogies.map((a) => ({
        concept: a.concept,
        analogy: a.analogy,
        chapter: a.chapter,
      })),
    };
  }
  for (const key of Object.keys(module.unknown)) {
    if (!KNOWN_FRONT_KEYS.has(key)) {
      front[key] = module.unknown[key];
    }
  }
  return front;
}

/** §10.3 — the inverse of {@link parseModuleFile}, deterministic. */
export function serializeModuleFile(module: ParsedModule): string {
  const yaml = stringifyYaml(frontMatterObject(module), {
    indent: 2,
    lineWidth: 0,
    singleQuote: false,
    defaultStringType: 'PLAIN',
  }).replace(/\n$/, '');
  const body = module.body.replace(/\s+$/, '');
  return `---\n${yaml}\n---\n\n${body}\n`;
}

// ------------------------------------------------------------------ the body

/** The `file://` uri of an absolute path, each segment percent-encoded. */
export function fileUriFor(absolute: string): string {
  const posix = absolute.replace(/\\/g, '/');
  const withRoot = /^[A-Za-z]:\//.test(posix) ? `/${posix}` : posix;
  return (
    'file://' +
    withRoot
      .split('/')
      .map((segment) => encodeURIComponent(segment).replace(/%3A/gi, ':'))
      .join('/')
  );
}

function posixSegments(value: string): string[] {
  return value
    .replace(/\\/g, '/')
    .replace(/^([A-Za-z]):\//, '$1:/')
    .split('/')
    .filter((segment) => segment.length > 0 && segment !== '.');
}

/**
 * §12.4 — the back link's destination: the source document as a path
 * **relative to the module's own folder**, each segment percent-encoded.
 * markdown-it refuses `file:` destinations outright (its default
 * `validateLink`), so an absolute `file://` link would render as text; a
 * relative path renders, and crossnote resolves it against the module's
 * directory into the `file://` href `clickTagA` opens. On a different drive
 * the `file://` form is the only one there is.
 */
export function relativeLink(fromDir: string, absolute: string): string {
  const from = posixSegments(fromDir);
  const to = posixSegments(absolute);
  if (
    from.length &&
    to.length &&
    /^[A-Za-z]:$/.test(to[0]) &&
    from[0] !== to[0]
  ) {
    return fileUriFor(absolute);
  }
  let common = 0;
  while (
    common < from.length &&
    common < to.length &&
    from[common] === to[common]
  ) {
    common++;
  }
  const up = from.slice(common).map(() => '..');
  const down = to.slice(common).map((segment) => encodeURIComponent(segment));
  const parts = [...up, ...down];
  const joined = parts.join('/');
  return /^\.\./.test(joined) ? joined : `./${joined}`;
}

/**
 * §12.4 — the back link. crossnote's `data-source-line` is the one-based
 * source line and `clickTagA` reads an `L` fragment as one-based too, so the
 * anchor's line goes into the fragment as it is; no fragment when unknown.
 */
export function backLink(
  module: Pick<ParsedModule, 'document' | 'passage'>,
  moduleDir: string,
): string {
  const target = relativeLink(moduleDir, module.document.absolute);
  const fragment =
    module.passage.line === null ? '' : `#L${module.passage.line}`;
  return `[${BACK_LINK_TEXT}](${target}${fragment})`;
}

/** The module's title: the body's `h1`, else the plan's, else the provisional one. */
export function titleOf(module: ParsedModule): string {
  const match = /^# (.+)$/m.exec(module.body);
  if (match) {
    return match[1].trim();
  }
  return module.plan?.title || provisionalTitle(module.passage.exact);
}

/** §10.2 — the frame: the `h1`, the _You were reading_ line and the quote. */
export function frameFor(
  module: Pick<ParsedModule, 'document' | 'passage'>,
  title: string,
  moduleDir: string,
): string {
  const heading = module.document.headings.length
    ? module.document.headings[module.document.headings.length - 1]
    : '';
  const where =
    `You were reading "${module.document.title.replace(/"/g, '”')}"` +
    (heading ? `, under "${heading.replace(/"/g, '”')}",` : '') +
    ` and stopped at this passage. ${backLink(module, moduleDir)}`;
  return `# ${title.replace(/\s+/g, ' ').trim()}\n\n${where}\n\n${toBlockquote(module.passage.exact)}\n`;
}

/** §9.7 — the body at Build: the frame with the provisional title. */
export function initialBody(
  module: Pick<ParsedModule, 'document' | 'passage'>,
  moduleDir: string,
): string {
  return frameFor(module, provisionalTitle(module.passage.exact), moduleDir);
}

/** §9.7 — the `h1` line rewritten with the plan's title. */
export function replaceTitle(body: string, title: string): string {
  const clean = title.replace(/\s+/g, ' ').trim();
  if (/^# .*$/m.test(body)) {
    return body.replace(/^# .*$/m, `# ${clean}`);
  }
  return `# ${clean}\n\n${body}`;
}

/** §9.7 — append one chapter: two newlines, then the markdown. Append only. */
export function appendChapter(body: string, chapterMarkdown: string): string {
  return `${body.replace(/\s+$/, '')}\n\n${chapterMarkdown.trim()}\n`;
}

/** §9.7 — the closing back link after the last chapter. */
export function appendClosingLink(
  body: string,
  module: Pick<ParsedModule, 'document' | 'passage'>,
  moduleDir: string,
): string {
  const link = backLink(module, moduleDir);
  if (body.replace(/\s+$/, '').endsWith(link)) {
    return body;
  }
  return `${body.replace(/\s+$/, '')}\n\n${link}\n`;
}

/** The `## ` headings of the body outside fences, in order: the chapters written. */
export function chapterHeadingsIn(body: string): string[] {
  const { prose } = maskFences(body);
  const out: string[] = [];
  for (const line of prose.split('\n')) {
    const match = /^## (\S.*)$/.exec(line);
    if (match) {
      out.push(match[1].trim());
    }
  }
  return out;
}

/** §10.3 — the last paragraph of the body's last chapter, for Continue. */
export function bridgeOf(body: string): string {
  const { prose } = maskFences(body);
  const lines = prose.split('\n');
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^## \S/.test(lines[i])) {
      start = i;
    }
  }
  if (start < 0) {
    return '';
  }
  let chapter = lines
    .slice(start + 1)
    .join('\n')
    .trim();
  // The closing back link stands alone at the end of a finished module.
  chapter = chapter
    .replace(/\n*\[[^\]]+\]\((?:file:|\.{1,2}\/)[^)]*\)\s*$/, '')
    .trim();
  // Re-run over the original body's fences so a figure at the end is skipped.
  return lastParagraph(chapter);
}

export function minutesOf(module: Pick<ParsedModule, 'chapters'>): number {
  const words = module.chapters.reduce(
    (sum, chapter) => sum + (chapter.actual ?? 0),
    0,
  );
  return Math.round(words / WORDS_PER_MINUTE);
}

/** §10.3 — what the quick pick and the sheets show. */
export function previewSummary(module: ParsedModule): ModuleSummary {
  const planned = module.chapters.length || module.plan?.chapters.length || 0;
  return {
    id: module.id,
    title: titleOf(module),
    created: module.created,
    status: module.status,
    chapters: planned,
    done: module.chapters.filter((chapter) => chapter.status === 'done').length,
    minutes: minutesOf(module),
    anchor: { ...module.passage },
    headings: module.document.headings.slice(),
    passage: module.passage.exact.replace(/\s+/g, ' ').trim().slice(0, 160),
  };
}
