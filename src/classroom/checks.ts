import { countWords } from '../read-aloud/help-prompt';
import { LEDGER_HEADING_RE } from './ledger';
import type { ChapterType } from './plan-prompt';

/**
 * The mechanical checks (`featrues/13-classroom/spec.md` §9.5): what a
 * chapter must not contain to be read aloud well, the length rules, the
 * handoff echo, and the one fix (a missing heading). Style never blocks the
 * module (D9): a failure gets one retry, a second failure is flagged; only
 * `empty` and `extra-heading` on the retry stop the build.
 *
 * Pure module: no `vscode`, no I/O.
 */

export const CHECK_CODES = [
  'em-dash',
  'table',
  'link',
  'inline-code',
  'html',
  'emoji',
  'heading',
  'extra-heading',
  'fence',
  'figures',
  'echo',
  'length-over',
  'length-target',
  'empty',
  'ledger-missing',
] as const;
export type CheckCode = (typeof CHECK_CODES)[number];

/** The two codes whose second failure stops the build (§9.5). */
export const STOP_CODES: readonly CheckCode[] = ['empty', 'extra-heading'];

export const MIN_CHAPTER_WORDS = 50;
export const LENGTH_TARGET_OVER = 1.4;
export const LENGTH_TARGET_UNDER = 0.6;
export const ECHO_WINDOW_CHARS = 300;
export const MAX_FIGURES = 2;

export interface CheckBrief {
  /** The planned title, for the `heading` fix. */
  title: string;
  type: ChapterType;
  target: number;
  ceiling: number;
  /** The previous chapter's closing bridge, or null for the first chapter. */
  previousBridge: string | null;
}

export interface CheckFailure {
  code: CheckCode;
  /** A short detail for the log (a count, a sample). */
  detail?: string;
}

export interface CheckResult {
  ok: boolean;
  failures: CheckFailure[];
  /** Fixes applied to `markdown` (the heading). */
  fixes: CheckCode[];
  /** Log-only observations. */
  notes: CheckCode[];
  /** The body with the fixes applied and without the ledger. */
  markdown: string;
  /** The `## Ledger` block, or null. */
  ledger: string | null;
  words: number;
}

/** The chapter's prose and its ledger block, split at `## Ledger`. */
export function splitLedger(markdown: string): {
  body: string;
  ledger: string | null;
} {
  const text = (typeof markdown === 'string' ? markdown : '').replace(
    /\r\n?/g,
    '\n',
  );
  const lines = text.split('\n');
  let at = -1;
  for (let i = 0; i < lines.length; i++) {
    if (
      LEDGER_HEADING_RE.test(lines[i]) ||
      /^\s*\*\*ledger\*\*\s*:?\s*$/i.test(lines[i])
    ) {
      at = i;
      break;
    }
  }
  if (at < 0) {
    return { body: text.trim(), ledger: null };
  }
  return {
    body: lines.slice(0, at).join('\n').trim(),
    ledger: lines.slice(at).join('\n').trim(),
  };
}

interface Masked {
  /** The prose with every fenced block replaced by a blank line. */
  prose: string;
  /** The fence tags, in order ('' for an untagged fence). */
  tags: string[];
}

const FENCE_RE = /^(\s*)(```+|~~~+)([^\n]*)\n[\s\S]*?\n\s*\2[ \t]*$/gm;

/** Fences out, their tags kept: everything below applies to the prose. */
export function maskFences(body: string): Masked {
  const tags: string[] = [];
  const prose = body.replace(FENCE_RE, (_match, _indent, _fence, info) => {
    tags.push(String(info).trim().split(/\s+/)[0] ?? '');
    return '';
  });
  return { prose, tags };
}

/** The last paragraph of a chapter's prose, fences skipped (the bridge). */
export function lastParagraph(body: string): string {
  const { prose } = maskFences(body);
  const paragraphs = prose
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p && !/^#{1,6}\s/.test(p));
  return paragraphs.length ? paragraphs[paragraphs.length - 1] : '';
}

/** Sentences of a paragraph, roughly: split after `.`, `!`, `?`. */
export function sentencesOf(text: string): string[] {
  return text
    .replace(/\s+/g, ' ')
    .trim()
    .split(/(?<=[.!?])\s+(?=[A-Z"“(])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function normaliseWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/** The first six words of the bridge's last sentence, normalised (§9.5 `echo`). */
export function echoNeedle(bridge: string): string[] {
  const sentences = sentencesOf(bridge);
  const last = sentences.length ? sentences[sentences.length - 1] : bridge;
  return normaliseWords(last).slice(0, 6);
}

/** Whether the words appear, in order and adjacent, in the text's first characters. */
function containsSequence(text: string, needle: string[]): boolean {
  if (!needle.length) {
    return true;
  }
  const words = normaliseWords(text);
  outer: for (let i = 0; i + needle.length <= words.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (words[i + j] !== needle[j]) {
        continue outer;
      }
    }
    return true;
  }
  return false;
}

/** The prose after the heading line. */
function bodyAfterHeading(prose: string): string {
  return prose.replace(/^\s*#{1,6}[^\n]*\n?/, '').trim();
}

/** The rule texts of §21.4, with the numbers filled in. */
export function ruleText(
  code: CheckCode,
  brief: Pick<CheckBrief, 'target' | 'ceiling'>,
  words: number = 0,
): string {
  switch (code) {
    case 'em-dash':
      return 'contains an em dash; punctuate with commas, colons or a new sentence';
    case 'table':
      return 'contains a table; narrate the comparison in prose';
    case 'link':
      return 'contains a link; attribute by name in prose';
    case 'inline-code':
      return 'contains inline code; say identifiers in words';
    case 'html':
      return 'contains HTML';
    case 'emoji':
      return 'contains an emoji or symbol';
    case 'extra-heading':
      return 'has more than one chapter heading; write one chapter';
    case 'fence':
      return 'has a fenced block that is not an ascii figure';
    case 'echo':
      return "does not open by picking up the previous chapter's closing bridge";
    case 'length-over':
      return `is longer than ${brief.ceiling} words`;
    case 'length-target':
      return `is ${words > brief.target ? 'longer' : 'shorter'} than the target of about ${brief.target} words`;
    case 'empty':
      return 'is too short to be a chapter';
    case 'heading':
      return 'does not begin with the chapter heading';
    case 'figures':
      return 'has more than two figures';
    case 'ledger-missing':
    default:
      return 'has no Ledger block';
  }
}

/**
 * §9.5 — run every rule over one chapter answer. `markdown` is the answer
 * after `normaliseHelpAnswer`; the result carries the body without the
 * ledger, with the heading fix applied, and the ledger block for the merge.
 */
export function checkChapter(markdown: string, brief: CheckBrief): CheckResult {
  const { body, ledger } = splitLedger(markdown);
  const failures: CheckFailure[] = [];
  const fixes: CheckCode[] = [];
  const notes: CheckCode[] = [];
  let text = body;

  // heading: the first non-blank line must be a `## ` heading.
  const firstLine = text.split('\n').find((line) => line.trim() !== '') ?? '';
  if (!/^##\s+\S/.test(firstLine.trim())) {
    if (/^#\s+\S/.test(firstLine.trim())) {
      // An `h1` in the heading's place is the chapter's heading, one level up.
      text = text.replace(/^\s*#\s+/, '## ');
    } else {
      text = `## ${brief.title}\n\n${text}`;
    }
    fixes.push('heading');
  }

  const { prose, tags } = maskFences(text);
  const after = bodyAfterHeading(prose);

  if (/—/.test(prose)) {
    failures.push({ code: 'em-dash' });
  }
  if (/^\s*\|/m.test(after) || / \| /.test(after)) {
    failures.push({ code: 'table' });
  }
  if (/\]\(/.test(after) || /<http/i.test(after) || /\[\[/.test(after)) {
    failures.push({ code: 'link' });
  }
  if (/`/.test(after)) {
    failures.push({ code: 'inline-code' });
  }
  // An autolink (`<https://…>`) is the link rule's; anything else that opens
  // like a tag is HTML.
  if (/<(?!https?:)[A-Za-z/!]/i.test(after)) {
    failures.push({ code: 'html' });
  }
  if (/\p{Extended_Pictographic}/u.test(after)) {
    failures.push({ code: 'emoji' });
  }
  const headings = prose
    .split('\n')
    .filter((line) => /^\s*#{1,2}\s+\S/.test(line));
  if (headings.length > 1) {
    failures.push({ code: 'extra-heading', detail: String(headings.length) });
  }
  const badFences = tags.filter((tag) => tag.toLowerCase() !== 'ascii');
  if (badFences.length) {
    failures.push({ code: 'fence', detail: badFences.join(',') || 'untagged' });
  }
  if (tags.length > MAX_FIGURES) {
    notes.push('figures');
  }
  if (brief.previousBridge) {
    const needle = echoNeedle(brief.previousBridge);
    const window = after.slice(0, ECHO_WINDOW_CHARS);
    const echoed = needle.length ? containsSequence(window, needle) : true;
    const asksAQuestion = sentencesOf(after)
      .slice(0, 2)
      .some((sentence) => sentence.includes('?'));
    if (!echoed && !asksAQuestion) {
      failures.push({ code: 'echo' });
    }
  }
  const words = countWords(after);
  if (words < MIN_CHAPTER_WORDS) {
    failures.push({ code: 'empty', detail: String(words) });
  } else {
    if (words > brief.ceiling) {
      failures.push({ code: 'length-over', detail: String(words) });
    }
    if (
      words > brief.target * LENGTH_TARGET_OVER ||
      words < brief.target * LENGTH_TARGET_UNDER
    ) {
      failures.push({ code: 'length-target', detail: String(words) });
    }
  }
  if (!ledger) {
    notes.push('ledger-missing');
  }
  return {
    ok: failures.length === 0,
    failures,
    fixes,
    notes,
    markdown: text.trim(),
    ledger,
    words,
  };
}
