import {
  hasEmDash,
  hasEmoji,
  hasHtml,
  hasInlineCode,
  hasLink,
  hasTable,
  maskFences,
  MIN_CHAPTER_WORDS,
  ruleText,
} from '../classroom/checks';
import { countWords } from '../read-aloud/help-prompt';

/**
 * The mechanical checks of a spoken edition (`featrues/15-convert-readable/
 * spec.md` §9.3): what one unit's answer must not contain to be heard well,
 * the runaway ceiling, the identifiers the voice cannot say, the source's
 * headings verbatim and in order, and the one fix (a constant heading-level
 * shift, applied back). A sibling of `checkChapter`, not a mode of it (D17):
 * an edition has many headings, so `extra-heading` is meaningless; there is
 * no previous bridge, so `echo` is; and `length-target` is replaced by the
 * ceiling. The rule predicates are the classroom's, exported for this.
 *
 * Fences are masked first, and **heading lines are excluded from every
 * content rule** (D19): the headings are the source's own, verbatim by
 * decision, and a source heading may legitimately hold an em dash or an
 * identifier. Headings are checked only by `heading-fidelity`.
 *
 * Soft failures (`sentence-length`, `length-under`) never cause a retry on
 * their own (D20): `ok` is true when nothing hard failed.
 *
 * Pure module: no `vscode`, no I/O.
 */

export const RETELL_CHECK_CODES = [
  'em-dash',
  'table',
  'link',
  'inline-code',
  'html',
  'emoji',
  'fence',
  'empty',
  'length-over',
  'identifier-leak',
  'heading-fidelity',
  'sentence-length',
  'length-under',
  'heading-level',
  'title-heading',
] as const;
export type RetellCheckCode = (typeof RETELL_CHECK_CODES)[number];

/** §9.3, D20 — named in a retry a hard failure caused, otherwise flagged. */
export const RETELL_SOFT_CODES: readonly RetellCheckCode[] = [
  'sentence-length',
  'length-under',
];

/** §9.3 — fewer words than this is `empty` (`MIN_CHAPTER_WORDS`). */
export const MIN_EDITION_WORDS: number = MIN_CHAPTER_WORDS;

/**
 * The `empty` floor for a unit: 50 words, or half of a short unit's own
 * words (never under 10). A 48-word section legitimately comes back as
 * thirty words; the Dev Host failed such a unit twice at the flat floor.
 */
export function emptyFloor(sourceWords: number): number {
  const source =
    typeof sourceWords === 'number' && Number.isFinite(sourceWords)
      ? sourceWords
      : 0;
  if (source <= 0) {
    return MIN_EDITION_WORDS;
  }
  return Math.min(MIN_EDITION_WORDS, Math.max(10, Math.round(source / 2)));
}
/** §9.3 — the sentence rule: an average above this, or any sentence above the next. */
export const SENTENCE_AVERAGE_MAX = 20;
export const SENTENCE_MAX = 35;
/** §9.3.1 — dotted abbreviations the voice says well enough. */
export const IDENTIFIER_ALLOWLIST: readonly string[] = [
  'e.g',
  'i.e',
  'etc',
  'a.m',
  'p.m',
  'U.S',
];

export interface SourceHeading {
  level: number;
  text: string;
}

export interface EditionCheckBrief {
  /** The unit's own word count, for `length-under`'s text. */
  sourceWords: number;
  /** `ceilingFor(sourceWords)`: above it is `length-over`. */
  ceiling: number;
  /** `underFor(sourceWords)`: below it is the soft `length-under`. */
  under: number;
  /** The unit's own headings from the source, its own heading first. */
  headings: SourceHeading[];
  /**
   * The document's title. An answer that opens with it as a heading of its
   * own (the engine echoing the breadcrumb) has that line removed, the
   * `title-heading` fix, before the headings are compared.
   */
  title?: string;
}

export interface EditionCheckFailure {
  code: RetellCheckCode;
  /** A short detail for the log and the retry text (a count, a sample). */
  detail?: string;
  /** D20 — never a retry on its own. */
  soft: boolean;
}

export interface EditionCheckResult {
  /** True when no hard rule failed. */
  ok: boolean;
  failures: EditionCheckFailure[];
  /** Fixes applied to `markdown` (`heading-level`). */
  fixes: RetellCheckCode[];
  /** Log-only observations. */
  notes: RetellCheckCode[];
  /** The answer with the fixes applied. */
  markdown: string;
  /** The answer's headings, text normalised, as they were before the fix. */
  headings: SourceHeading[];
  /** The prose's word count, fences masked and heading lines excluded. */
  words: number;
  /**
   * The constant level offset found by `heading-fidelity`; null when it
   * failed, or when the levels wandered and were set to the source's own.
   */
  offset: number | null;
}

// ------------------------------------------------------------------ headings

const HEADING_LINE_RE = /^\s{0,3}(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/;

/** The fence regex of `classroom/checks.ts`, for the length-keeping mask. */
const FENCE_RE = /^(\s*)(```+|~~~+)([^\n]*)\n[\s\S]*?\n\s*\2[ \t]*$/gm;

/** Fences blanked but their length kept, so line indexes still line up. */
function maskFencesKeepingLength(markdown: string): string {
  return markdown.replace(FENCE_RE, (match) => match.replace(/[^\n]/g, ' '));
}

/** A heading's text as the fidelity rule compares it. */
export function normaliseHeadingText(text: string): string {
  return (typeof text === 'string' ? text : '')
    .replace(/[*_`]/g, '')
    .replace(/[ \t]*#+[ \t]*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function headingOfLine(line: string): SourceHeading | null {
  const match = HEADING_LINE_RE.exec(line);
  if (!match) {
    return null;
  }
  return { level: match[1].length, text: normaliseHeadingText(match[2]) };
}

/** §9.3.2 — the answer's ATX headings outside fences, text normalised. */
export function headingsOf(markdown: string): SourceHeading[] {
  const text = (typeof markdown === 'string' ? markdown : '').replace(
    /\r\n?/g,
    '\n',
  );
  const out: SourceHeading[] = [];
  for (const line of maskFences(text).prose.split('\n')) {
    const heading = headingOfLine(line);
    if (heading) {
      out.push(heading);
    }
  }
  return out;
}

/**
 * §9.3.2 — the `heading-level` fix: every ATX heading outside a fence moved
 * by `-offset` levels (an offset of −1 means the answer's levels are one
 * shallower than the source's, so each gains one), clamped to 1…6.
 */
export function normaliseHeadings(markdown: string, offset: number): string {
  const text = (typeof markdown === 'string' ? markdown : '').replace(
    /\r\n?/g,
    '\n',
  );
  const shift = Math.round(offset) || 0;
  if (!shift) {
    return text;
  }
  const masked = maskFencesKeepingLength(text).split('\n');
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const match = HEADING_LINE_RE.exec(masked[i] ?? '');
    if (!match) {
      continue;
    }
    const level = Math.max(1, Math.min(6, match[1].length - shift));
    lines[i] = lines[i].replace(/^(\s{0,3})#{1,6}/, `$1${'#'.repeat(level)}`);
  }
  return lines.join('\n');
}

// --------------------------------------------------------------- the prose

/** The non-heading lines of the fence-masked prose (D19). */
function contentOf(prose: string): string {
  return prose
    .split('\n')
    .filter((line) => !HEADING_LINE_RE.test(line))
    .join('\n');
}

const IDENTIFIER_SLASH_RE = /[^\s][/~<>‹›][^\s]/;
const IDENTIFIER_DOT_RE = /[A-Za-z]\.[A-Za-z]/;
const EDGE_PUNCTUATION_RE = /^[([{"'“‘*_]+|[)\]}"'”’*_.,;:!?]+$/g;

/**
 * §9.3.1 — the tokens the voice cannot say: a slash, tilde or angle bracket
 * between two non-space characters, or a letter, a dot and a letter, outside
 * heading lines. Underscore is not in the set (the reader speaks it as a
 * space), a decimal never matches (`\d.\d` is not letter-dot-letter), and
 * the short allowlist of abbreviations is skipped.
 */
export function identifierLeaks(prose: string): string[] {
  const out: string[] = [];
  for (const raw of contentOf(prose).split(/\s+/)) {
    if (!raw) {
      continue;
    }
    const token = raw.replace(EDGE_PUNCTUATION_RE, '');
    if (!token) {
      continue;
    }
    const bare = token.replace(/\.+$/, '').toLowerCase();
    if (
      IDENTIFIER_ALLOWLIST.some((allowed) => allowed.toLowerCase() === bare)
    ) {
      continue;
    }
    if (IDENTIFIER_SLASH_RE.test(token) || IDENTIFIER_DOT_RE.test(token)) {
      out.push(token);
    }
  }
  return out;
}

const LIST_MARKER_RE = /^\s*(?:[-*+]|\d+[.)])\s+/;

/**
 * The sentences of an edition's prose: `sentencesOf`'s split (after `.`, `!`
 * or `?`, before a capital, a quote or a bracket), with a closing quote or
 * bracket allowed between the terminal punctuation and the space. An edition
 * says identifiers in quotes — `reading "ADR-0007." A decision lives …` —
 * and the classroom's split, which the echo rule keeps, would run two such
 * sentences together and report one of thirty-nine words.
 */
export function retellSentencesOf(text: string): string[] {
  return text
    .replace(/\s+/g, ' ')
    .trim()
    .split(/(?<=[.!?]["”’)\]]*)\s+(?=[A-Z"“(])/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

/**
 * §9.3 — the sentence rule's numbers over the prose: heading lines and list
 * markers excluded (D19), sentences split by {@link retellSentencesOf}.
 */
export function sentenceStats(prose: string): {
  count: number;
  average: number;
  longest: number;
} {
  const lines = contentOf(prose)
    .split('\n')
    .map((line) => line.replace(LIST_MARKER_RE, '').trim())
    .filter(Boolean);
  const sentences = retellSentencesOf(lines.join('\n'));
  let total = 0;
  let longest = 0;
  for (const sentence of sentences) {
    const words = countWords(sentence);
    total += words;
    if (words > longest) {
      longest = words;
    }
  }
  const count = sentences.length;
  return {
    count,
    average: count ? Math.round((total / count) * 10) / 10 : 0,
    longest,
  };
}

// --------------------------------------------------------------- the rules

/** §21.3 — the rule texts, with the numbers filled in. */
export function retellRuleText(
  code: RetellCheckCode,
  brief: EditionCheckBrief,
  detail?: string,
  words: number = 0,
): string {
  switch (code) {
    case 'em-dash':
    case 'link':
    case 'inline-code':
    case 'html':
    case 'emoji':
      return ruleText(code, { target: 0, ceiling: brief.ceiling }, words);
    case 'table':
      return 'contains a table; narrate it as sentences, one per row';
    case 'fence':
      return 'contains a fenced block; say what the code does instead';
    case 'identifier-leak':
      return `contains ${detail || 'an identifier'}, which the voice cannot say; give it a spoken name`;
    case 'heading-fidelity':
      return `changed a heading: the section's headings must appear word for word, in order${
        detail ? ` (${detail})` : ''
      }`;
    case 'sentence-length':
      return `averages ${detail || '?'} words a sentence; keep to twenty or fewer and none above thirty-five`;
    case 'length-over':
      return `is ${words} words against a ceiling of ${brief.ceiling}`;
    case 'length-under':
      return `is ${words} words against a section of ${brief.sourceWords}; a faithful edition is not shorter than the section`;
    case 'empty':
      return 'is too short to be an edition';
    case 'heading-level':
    default:
      return 'shifted every heading by one level';
  }
}

function quoteHeading(heading: SourceHeading): string {
  return `"${'#'.repeat(Math.max(1, Math.min(6, heading.level)))} ${heading.text}"`;
}

/**
 * §9.3.2 — the headings' text, in order; then their levels. Texts that match
 * pass. A constant offset in {−1, 0, +1} is reported as such; any other level
 * pattern (the Dev Host produced an `h1` unit heading over `h3` sub-headings)
 * passes too, with `offset: null`, and the fix sets every level to the
 * source's own — the levels are ours to set once the texts line up.
 */
function headingFidelity(
  answer: SourceHeading[],
  source: SourceHeading[],
): { offset: number | null } | { detail: string } {
  const wanted = source.map((heading) => ({
    level: heading.level,
    text: normaliseHeadingText(heading.text),
  }));
  if (answer.length !== wanted.length) {
    return {
      detail: `${wanted.length} heading${wanted.length === 1 ? '' : 's'} expected, ${answer.length} found`,
    };
  }
  if (!wanted.length) {
    return { offset: 0 };
  }
  let offset: number | null = null;
  let uneven = false;
  for (let i = 0; i < wanted.length; i++) {
    if (answer[i].text !== wanted[i].text) {
      return {
        detail: `expected ${quoteHeading(wanted[i])}, got ${quoteHeading(answer[i])}`,
      };
    }
    const delta = answer[i].level - wanted[i].level;
    if (offset === null) {
      offset = delta;
    } else if (delta !== offset) {
      uneven = true;
    }
  }
  if (uneven || offset === null || offset < -1 || offset > 1) {
    return { offset: null };
  }
  return { offset };
}

/**
 * §9.3.2 — the `heading-level` fix for an uneven shift: the i-th ATX heading
 * outside a fence takes `levels[i]`, the source's own level.
 */
export function applyHeadingLevels(markdown: string, levels: number[]): string {
  const text = (typeof markdown === 'string' ? markdown : '').replace(
    /\r\n?/g,
    '\n',
  );
  const masked = maskFencesKeepingLength(text).split('\n');
  const lines = text.split('\n');
  let index = 0;
  for (let i = 0; i < lines.length && index < levels.length; i++) {
    const match = HEADING_LINE_RE.exec(masked[i] ?? '');
    if (!match) {
      continue;
    }
    const level = Math.max(1, Math.min(6, Math.round(levels[index]) || 1));
    lines[i] = lines[i].replace(/^(\s{0,3})#{1,6}/, `$1${'#'.repeat(level)}`);
    index++;
  }
  return lines.join('\n');
}

/**
 * The `title-heading` fix: an answer whose first heading is the document's
 * title, when the unit's own first heading is not, loses that line. The
 * engine writes the breadcrumb's title as a heading now and then; the frame
 * already carries it.
 */
function stripTitleHeading(
  text: string,
  brief: EditionCheckBrief,
): string | null {
  const title = normaliseHeadingText(brief.title ?? '');
  if (!title) {
    return null;
  }
  const wanted = brief.headings || [];
  if (
    wanted.length &&
    normaliseHeadingText(wanted[0].text).toLowerCase() === title.toLowerCase()
  ) {
    return null;
  }
  const masked = maskFencesKeepingLength(text).split('\n');
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const match = HEADING_LINE_RE.exec(masked[i] ?? '');
    if (!match) {
      if (lines[i].trim() !== '') {
        // Prose before the first heading: the answer did not open with one.
        return null;
      }
      continue;
    }
    if (normaliseHeadingText(match[2]).toLowerCase() !== title.toLowerCase()) {
      return null;
    }
    lines.splice(i, 1);
    return lines.join('\n').replace(/^\n+/, '').trim();
  }
  return null;
}

/**
 * §9.3 — run every rule over one unit's answer. `markdown` is the answer
 * after `normaliseHelpAnswer`; the result carries the answer with the
 * heading-level fix applied, so the written body always carries the source's
 * own levels.
 */
export function checkEdition(
  markdown: string,
  brief: EditionCheckBrief,
): EditionCheckResult {
  let text = (typeof markdown === 'string' ? markdown : '')
    .replace(/\r\n?/g, '\n')
    .trim();
  const failures: EditionCheckFailure[] = [];
  const fixes: RetellCheckCode[] = [];
  const notes: RetellCheckCode[] = [];
  const stripped = stripTitleHeading(text, brief);
  if (stripped !== null) {
    text = stripped;
    fixes.push('title-heading');
  }
  const hard = (code: RetellCheckCode, detail?: string) => {
    failures.push(
      detail ? { code, detail, soft: false } : { code, soft: false },
    );
  };
  const soft = (code: RetellCheckCode, detail?: string) => {
    failures.push(detail ? { code, detail, soft: true } : { code, soft: true });
  };

  const { prose, tags } = maskFences(text);
  const content = contentOf(prose);

  if (hasEmDash(content)) {
    hard('em-dash');
  }
  if (hasTable(content)) {
    hard('table');
  }
  if (hasLink(content)) {
    hard('link');
  }
  if (hasInlineCode(content)) {
    hard('inline-code');
  }
  if (hasHtml(content)) {
    hard('html');
  }
  if (hasEmoji(content)) {
    hard('emoji');
  }
  if (tags.length) {
    hard('fence', tags.map((tag) => tag || 'untagged').join(','));
  }

  const words = countWords(content);
  if (words < emptyFloor(brief.sourceWords)) {
    hard('empty', String(words));
  } else {
    if (words > brief.ceiling) {
      hard('length-over', String(words));
    }
    if (words < brief.under) {
      soft('length-under', String(words));
    }
  }

  const leaks = identifierLeaks(prose);
  if (leaks.length) {
    hard('identifier-leak', leaks[0]);
  }

  const headings = headingsOf(text);
  const wanted = brief.headings || [];
  const fidelity = headingFidelity(headings, wanted);
  let offset: number | null = null;
  let fixed = text;
  if ('detail' in fidelity) {
    hard('heading-fidelity', fidelity.detail);
  } else {
    offset = fidelity.offset;
    if (offset === null) {
      // The texts line up but the levels wander: every level is set to the
      // source's own, so the file keeps one `h1` and the outline holds.
      fixed = applyHeadingLevels(
        text,
        wanted.map((heading) => heading.level),
      );
      fixes.push('heading-level');
    } else if (offset !== 0) {
      fixed = normaliseHeadings(text, offset);
      fixes.push('heading-level');
    }
  }

  const stats = sentenceStats(prose);
  if (
    stats.count > 0 &&
    (stats.average > SENTENCE_AVERAGE_MAX || stats.longest > SENTENCE_MAX)
  ) {
    soft('sentence-length', stats.average.toFixed(1));
  }

  return {
    ok: failures.every((failure) => failure.soft),
    failures,
    fixes,
    notes,
    markdown: fixed.trim(),
    headings,
    words,
    offset,
  };
}
