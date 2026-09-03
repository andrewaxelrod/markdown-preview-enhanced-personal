/**
 * Sentence packing and prosody context windows (F11, R2 §8.4, §4.4).
 *
 * Pure module: no `vscode`, no I/O. Text is split on sentence boundaries into
 * chunks packed towards a small *target* size — a short first chunk so audio
 * starts quickly, larger ones after it — and never above the model's limit
 * minus a 5 % margin; each chunk carries the tail of the previous chunk and
 * the head of the next one so ElevenLabs keeps the prosody continuous.
 *
 * Small chunks are what make synthesis lazy (and cheap): the controller only
 * requests the chunk after the one that is playing, so stopping early costs
 * at most one chunk beyond the audio already heard.
 *
 * Invariant relied on by F4: `text.slice(chunk.charOffset, chunk.charOffset +
 * chunk.text.length) === chunk.text`, so a word span computed against the
 * chunk can be shifted by `charOffset` and still index the full request text.
 */

/** F11 — `previous_text` / `next_text` are capped at 300 characters. */
export const CONTEXT_WINDOW_CHARS = 300;

/** F11 — chunks stay under the model limit minus 5 %. */
export const LIMIT_MARGIN = 0.05;

/**
 * Target size of the first chunk: one or two sentences (~15 s of speech), so
 * the time to first audio is the synthesis of a short text, not of the block.
 */
export const FIRST_CHUNK_TARGET_CHARS = 250;

/**
 * Target size of every later chunk (~45 s of speech): long enough to hide the
 * next request's latency behind playback, short enough that a stop wastes
 * little.
 */
export const CHUNK_TARGET_CHARS = 700;

export interface ChunkContext {
  previousText?: string;
  nextText?: string;
}

/** Packing targets in characters; each is capped by the model limit. */
export interface ChunkTargets {
  first: number;
  rest: number;
}

export const DEFAULT_CHUNK_TARGETS: Readonly<ChunkTargets> = {
  first: FIRST_CHUNK_TARGET_CHARS,
  rest: CHUNK_TARGET_CHARS,
};

export interface Chunk {
  index: number;
  text: string;
  charOffset: number;
  previousText: string;
  nextText: string;
}

export interface ChunkPlan {
  chunks: Chunk[];
  limit: number;
}

interface Span {
  start: number;
  end: number;
}

/** The model limit with the F11 safety margin applied. */
export function effectiveLimit(modelLimit: number): number {
  if (!Number.isFinite(modelLimit) || modelLimit <= 0) {
    return 1;
  }
  return Math.max(1, Math.floor(modelLimit * (1 - LIMIT_MARGIN)));
}

function isWhitespace(char: string): boolean {
  return /\s/.test(char);
}

/** Number of characters left after trimming both ends of `text[start, end)`. */
function trimmedLength(text: string, start: number, end: number): number {
  let from = start;
  let to = end;
  while (from < to && isWhitespace(text[from])) {
    from++;
  }
  while (to > from && isWhitespace(text[to - 1])) {
    to--;
  }
  return to - from;
}

/** `text[start, end)` trimmed, together with its absolute offset. */
function trimSpan(
  text: string,
  start: number,
  end: number,
): { value: string; offset: number } {
  let from = start;
  let to = end;
  while (from < to && isWhitespace(text[from])) {
    from++;
  }
  while (to > from && isWhitespace(text[to - 1])) {
    to--;
  }
  return { value: text.slice(from, to), offset: from };
}

function fallbackSentences(
  text: string,
): Array<{ index: number; segment: string }> {
  const out: Array<{ index: number; segment: string }> = [];
  const re = /[.!?]+\s+|[。！？]+/g;
  let start = 0;
  let match = re.exec(text);
  while (match !== null) {
    const end = match.index + match[0].length;
    out.push({ index: start, segment: text.slice(start, end) });
    start = end;
    match = re.exec(text);
  }
  if (start < text.length) {
    out.push({ index: start, segment: text.slice(start) });
  }
  return out;
}

/**
 * `Intl.Segmenter` sentence granularity, falling back to a split after
 * `[.!?。！？]` plus whitespace when the segmenter or the locale is unusable
 * (decision (i)).
 */
export function splitSentences(
  text: string,
  locale: string,
): Array<{ index: number; segment: string }> {
  if (typeof Intl === 'undefined' || typeof Intl.Segmenter !== 'function') {
    return fallbackSentences(text);
  }
  let segmenter: Intl.Segmenter;
  try {
    segmenter = new Intl.Segmenter(locale, { granularity: 'sentence' });
  } catch {
    try {
      segmenter = new Intl.Segmenter('en', { granularity: 'sentence' });
    } catch {
      return fallbackSentences(text);
    }
  }
  const out: Array<{ index: number; segment: string }> = [];
  for (const data of segmenter.segment(text)) {
    out.push({ index: data.index, segment: data.segment });
  }
  return out;
}

/** Last `max` characters of `text` (R2 §4.4 continuity window). */
export function contextTail(
  text: string,
  max: number = CONTEXT_WINDOW_CHARS,
): string {
  if (!text) {
    return '';
  }
  return text.length <= max ? text : text.slice(text.length - max);
}

/** First `max` characters of `text` (R2 §4.4 continuity window). */
export function contextHead(
  text: string,
  max: number = CONTEXT_WINDOW_CHARS,
): string {
  if (!text) {
    return '';
  }
  return text.length <= max ? text : text.slice(0, max);
}

/**
 * Split one oversized sentence at the last whitespace before the limit (at the
 * limit itself when the sentence contains no whitespace there).
 */
function hardSplit(
  text: string,
  start: number,
  end: number,
  limit: number,
): Span[] {
  const pieces: Span[] = [];
  let cursor = start;
  while (cursor < end) {
    while (cursor < end && isWhitespace(text[cursor])) {
      cursor++;
    }
    if (cursor >= end) {
      break;
    }
    if (trimmedLength(text, cursor, end) <= limit) {
      pieces.push({ start: cursor, end });
      break;
    }
    let cut = cursor + limit;
    for (let i = cut - 1; i > cursor; i--) {
      if (isWhitespace(text[i])) {
        cut = i;
        break;
      }
    }
    pieces.push({ start: cursor, end: cut });
    cursor = cut;
  }
  return pieces;
}

/** Sentences, with any oversized sentence hard-split, as absolute spans. */
function buildPieces(text: string, limit: number, locale: string): Span[] {
  const pieces: Span[] = [];
  for (const sentence of splitSentences(text, locale)) {
    const start = sentence.index;
    const end = sentence.index + sentence.segment.length;
    if (trimmedLength(text, start, end) === 0) {
      continue;
    }
    if (trimmedLength(text, start, end) <= limit) {
      pieces.push({ start, end });
    } else {
      pieces.push(...hardSplit(text, start, end, limit));
    }
  }
  return pieces;
}

function normalizeTarget(value: number, limit: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return limit;
  }
  return Math.max(1, Math.min(limit, Math.floor(value)));
}

/**
 * Greedy packing of whole sentences into chunks: the first chunk grows up to
 * `targets.first` characters, later ones up to `targets.rest`, and no chunk
 * ever exceeds `effectiveLimit(modelLimit)` (a single sentence longer than its
 * target stays whole up to the limit, and is hard-split above it). The R2
 * §4.4 context windows are filled in; `outer` supplies the neighbouring
 * blocks' text for the first and last chunk (F11 "single-chunk block reads
 * pass the neighbouring eligible blocks' text the same way").
 */
export function planChunks(
  text: string,
  modelLimit: number,
  locale: string,
  outer?: ChunkContext,
  targets: Readonly<ChunkTargets> = DEFAULT_CHUNK_TARGETS,
): ChunkPlan {
  const limit = effectiveLimit(modelLimit);
  const firstTarget = normalizeTarget(targets.first, limit);
  const restTarget = normalizeTarget(targets.rest, limit);
  const pieces = buildPieces(text, limit, locale);
  const groups: Span[] = [];
  for (const piece of pieces) {
    const last = groups.length > 0 ? groups[groups.length - 1] : undefined;
    const cap = groups.length === 1 ? firstTarget : restTarget;
    if (last && trimmedLength(text, last.start, piece.end) <= cap) {
      last.end = piece.end;
    } else {
      groups.push({ start: piece.start, end: piece.end });
    }
  }

  const chunks: Chunk[] = [];
  for (const group of groups) {
    const trimmed = trimSpan(text, group.start, group.end);
    if (trimmed.value.length === 0) {
      continue;
    }
    chunks.push({
      index: chunks.length,
      text: trimmed.value,
      charOffset: trimmed.offset,
      previousText: '',
      nextText: '',
    });
  }

  for (let i = 0; i < chunks.length; i++) {
    chunks[i].previousText =
      i === 0
        ? contextTail(outer?.previousText ?? '')
        : contextTail(chunks[i - 1].text);
    chunks[i].nextText =
      i === chunks.length - 1
        ? contextHead(outer?.nextText ?? '')
        : contextHead(chunks[i + 1].text);
  }

  return { chunks, limit };
}

/**
 * Re-plan the tail of a request after `text_too_long` (§3.3, G-07). The
 * returned chunks keep `charOffset` relative to the *full* request text, so
 * word spans stay comparable with the chunks already posted.
 */
export function replanFrom(
  text: string,
  from: number,
  newLimit: number,
  locale: string,
  outer?: ChunkContext,
  targets: Readonly<ChunkTargets> = DEFAULT_CHUNK_TARGETS,
): Chunk[] {
  const offset = Math.max(0, Math.min(from, text.length));
  const plan = planChunks(text.slice(offset), newLimit, locale, outer, targets);
  return plan.chunks.map((chunk) => ({
    ...chunk,
    charOffset: chunk.charOffset + offset,
  }));
}
