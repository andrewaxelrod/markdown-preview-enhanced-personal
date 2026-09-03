import type { WordSpan } from './word-spans';

/**
 * Speakable text (F5; cost pass 2026-09-02).
 *
 * Only letters, marks and digits of any script, whitespace and the sentence
 * punctuation in {@link SPEAKABLE_PUNCTUATION} ever reach ElevenLabs.
 * Everything else — markdown residue (`**`, `#`, `>`, `[x]`, backticks,
 * `~~`), brackets, symbols, emoji — is dropped here before chunking, and
 * `ElevenLabsClient` refuses a request containing anything outside the set
 * ({@link assertSpeakable}) as the last line of defence.
 *
 * Pure module: no `vscode`, no I/O.
 *
 * Why not plain `[a-z0-9]`: ElevenLabs takes its pauses and intonation from
 * `.,;:!?`, reads "don't" and "3.5" from the apostrophe and the decimal
 * point, and the preview is not English-only. And the webview built its
 * offset map against the *original* text, so the sanitised text carries a
 * `map` back to the original offsets and word spans are mapped back with
 * {@link mapSpanBack} before they are posted.
 */

/** Punctuation kept verbatim: it shapes prosody or is read as a word. */
export const SPEAKABLE_PUNCTUATION = '.,;:!?\'"‘’“”«»()…¿¡–—-%$€£¥°&+=/@';

/** Hyphens that join a word when a letter or digit sits on both sides. */
const WORD_JOINERS = new Set(['-', '‐', '‑']);

/** Characters that separate words rather than being spoken. */
const WORD_SEPARATORS = new Set(['_', '|']);

/** A literal task-list marker, dropped as one unit so its `x` is not read. */
const TASK_MARKER_RE = /^\[[ xX]\]$/;

const PUNCTUATION_SET = new Set(Array.from(SPEAKABLE_PUNCTUATION));

const WORD_CHAR_RE = /^[\p{L}\p{M}\p{N}]$/u;
const SPACE_RE = /^\s$/u;

function escapeForClass(chars: string): string {
  return chars.replace(/[\\\]^-]/g, '\\$&');
}

/**
 * Matches one character that must never be sent. The class-based twin of
 * {@link sanitizeForSpeech}: every character of its output passes this test.
 */
export const UNSPEAKABLE_RE = new RegExp(
  `[^\\p{L}\\p{M}\\p{N}\\s${escapeForClass(SPEAKABLE_PUNCTUATION)}\\u2010\\u2011]`,
  'u',
);

export interface SpeakableText {
  /** The text to send: sanitised, whitespace-collapsed, trimmed. */
  text: string;
  /**
   * `map[i]` is the UTF-16 offset in the original text of the character
   * `text[i]` stands for. A collapsed space maps to the first character of
   * the whitespace or dropped run it replaced.
   */
  map: number[];
}

/**
 * `space`: whitespace or an explicit separator, always a word boundary.
 * `drop`: removed; it becomes a word boundary only when it would otherwise
 * glue two words ("5*3" -> "5 3"), never before punctuation ("**Hi**," ->
 * "Hi,").
 */
type Kind = 'keep' | 'space' | 'drop';

function codePointAt(text: string, index: number): string | undefined {
  if (index < 0 || index >= text.length) {
    return undefined;
  }
  let at = index;
  const unit = text.charCodeAt(at);
  if (unit >= 0xdc00 && unit <= 0xdfff && at > 0) {
    at--;
  }
  const cp = text.codePointAt(at);
  return cp === undefined ? undefined : String.fromCodePoint(cp);
}

function isWordChar(char: string | undefined): boolean {
  return char !== undefined && WORD_CHAR_RE.test(char);
}

function classify(original: string, index: number, char: string): Kind {
  if (SPACE_RE.test(char)) {
    return 'space';
  }
  if (WORD_CHAR_RE.test(char)) {
    return 'keep';
  }
  if (WORD_JOINERS.has(char)) {
    // "read-aloud" keeps its hyphen; a list marker, a dash or a leading
    // minus is dropped (the em/en dashes in SPEAKABLE_PUNCTUATION are kept
    // as prosody).
    return isWordChar(codePointAt(original, index - 1)) &&
      isWordChar(codePointAt(original, index + char.length))
      ? 'keep'
      : 'drop';
  }
  if (PUNCTUATION_SET.has(char)) {
    return 'keep';
  }
  if (WORD_SEPARATORS.has(char)) {
    return 'space';
  }
  return 'drop';
}

/**
 * The speakable form of `original` with the offset map back to it. Leading,
 * trailing and repeated separators collapse the way the webview's extraction
 * collapses whitespace, so the result is trimmed.
 */
export function sanitizeForSpeech(original: string): SpeakableText {
  const out: string[] = [];
  const map: number[] = [];
  // The run of separators/dropped characters since the last kept character:
  // where it starts, and whether it contains a real word boundary.
  let pending = -1;
  let pendingSpace = false;
  let lastKept = '';
  const skip = (index: number, kind: Kind) => {
    if (out.length === 0) {
      return;
    }
    if (pending < 0) {
      pending = index;
    }
    if (kind === 'space') {
      pendingSpace = true;
    }
  };
  for (let i = 0; i < original.length;) {
    const cp = original.codePointAt(i);
    if (cp === undefined) {
      break;
    }
    const char = String.fromCodePoint(cp);
    if (char === '[' && TASK_MARKER_RE.test(original.slice(i, i + 3))) {
      skip(i, 'drop');
      i += 3;
      continue;
    }
    const kind = classify(original, i, char);
    if (kind === 'keep') {
      if (pending >= 0) {
        if (pendingSpace || (isWordChar(lastKept) && WORD_CHAR_RE.test(char))) {
          out.push(' ');
          map.push(pending);
        }
        pending = -1;
        pendingSpace = false;
      }
      out.push(char);
      for (let k = 0; k < char.length; k++) {
        map.push(i + k);
      }
      lastKept = char;
    } else {
      skip(i, kind);
    }
    i += char.length;
  }
  return { text: out.join(''), map };
}

/** `true` when no character of `text` is outside the speakable set. */
export function isSpeakable(text: string): boolean {
  return !UNSPEAKABLE_RE.test(text);
}

/** Up to five distinct offending characters, for an error message. */
export function unspeakableSample(text: string): string {
  const seen = new Set<string>();
  for (const char of text) {
    if (UNSPEAKABLE_RE.test(char)) {
      seen.add(char);
      if (seen.size === 5) {
        break;
      }
    }
  }
  return Array.from(seen).join('');
}

/**
 * Throws when `text` contains a character that must not be sent. Called by
 * the HTTP client on every field it sends; a throw here is a programming
 * error (the controller sanitises everything), never a user-facing state.
 */
export function assertSpeakable(text: string, field: string): void {
  if (!isSpeakable(text)) {
    throw new Error(
      `read aloud: ${field} contains characters that must not be sent to ElevenLabs: ${JSON.stringify(
        unspeakableSample(text),
      )}`,
    );
  }
}

/**
 * A word span computed against sanitised text, re-expressed in the original
 * text's offsets through `map`; `undefined` when the span falls outside it.
 */
export function mapSpanBack(
  span: WordSpan,
  map: number[],
): WordSpan | undefined {
  if (span.charEnd <= span.charStart) {
    return undefined;
  }
  const start = map[span.charStart];
  const last = map[span.charEnd - 1];
  if (start === undefined || last === undefined || last < start) {
    return undefined;
  }
  return { ...span, charStart: start, charEnd: last + 1 };
}
