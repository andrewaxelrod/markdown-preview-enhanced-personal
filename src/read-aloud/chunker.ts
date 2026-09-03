/**
 * Sentence packing (F11).
 *
 * Pure module: no `vscode`, no I/O. Text is split on sentence boundaries into
 * chunks packed towards a small *target* size — a short first chunk so audio
 * starts quickly, larger ones after it — and never above the request limit
 * minus a 5 % margin.
 *
 * Small chunks are what make the first sound arrive fast: a Kokoro request
 * for a whole 5,000-character block takes seconds before anything plays, a
 * one-or-two-sentence request well under a second. Later chunks are
 * synthesised while the earlier ones play (the controller's prefetch window).
 *
 * A continuous read ({@link planReadChunks}) is chunked block by block: no
 * chunk ever crosses a block boundary, so the pause between a heading and its
 * paragraph comes from separate audio, not from merged text, and every chunk
 * knows which block it belongs to.
 *
 * Invariant relied on by F4: `text.slice(chunk.charOffset, chunk.charOffset +
 * chunk.text.length) === chunk.text` for the block's text, so a word span
 * computed against the chunk can be shifted by `charOffset` and still index
 * the block.
 */

/** F11 — chunks stay under the request limit minus 5 %. */
export const LIMIT_MARGIN = 0.05;

/**
 * Target size of the first chunk of a read: one or two sentences (~15 s of
 * speech), so the time to first audio is the synthesis of a short text.
 */
export const FIRST_CHUNK_TARGET_CHARS = 250;

/**
 * Target size of every later chunk (~45 s of speech): long enough to hide the
 * next request's latency behind playback, short enough that a stop wastes
 * little synthesis.
 */
export const CHUNK_TARGET_CHARS = 700;

/** Packing targets in characters; each is capped by the request limit. */
export interface ChunkTargets {
  first: number;
  rest: number;
}

export const DEFAULT_CHUNK_TARGETS: Readonly<ChunkTargets> = {
  first: FIRST_CHUNK_TARGET_CHARS,
  rest: CHUNK_TARGET_CHARS,
};

export interface Chunk {
  /** Position in the whole read. */
  index: number;
  /** Which block of the read the chunk was cut from. */
  blockIndex: number;
  text: string;
  /** Offset of `text` inside its block's text. */
  charOffset: number;
}

export interface ChunkPlan {
  chunks: Chunk[];
  limit: number;
}

interface Span {
  start: number;
  end: number;
}

/** The request limit with the F11 safety margin applied. */
export function effectiveLimit(requestLimit: number): number {
  if (!Number.isFinite(requestLimit) || requestLimit <= 0) {
    return 1;
  }
  return Math.max(1, Math.floor(requestLimit * (1 - LIMIT_MARGIN)));
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
 * ever exceeds `effectiveLimit(requestLimit)` (a single sentence longer than
 * its target stays whole up to the limit, and is hard-split above it). Every
 * chunk gets `blockIndex` 0; {@link planReadChunks} renumbers for a read.
 */
export function planChunks(
  text: string,
  requestLimit: number,
  locale: string,
  targets: Readonly<ChunkTargets> = DEFAULT_CHUNK_TARGETS,
): ChunkPlan {
  const limit = effectiveLimit(requestLimit);
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
      blockIndex: 0,
      text: trimmed.value,
      charOffset: trimmed.offset,
    });
  }
  return { chunks, limit };
}

/**
 * The chunk plan of a continuous read (decision 5): block `i` of `blocks` is
 * packed on its own, so no chunk crosses a block boundary, and the chunks
 * are concatenated in document order with `blockIndex` set. Only the very
 * first chunk of the read uses the small `targets.first`; the first chunk of
 * every later block is already covered by the prefetch window, so it packs
 * to `targets.rest` like any other. `charOffset` stays relative to the
 * chunk's own block. A block with no speakable text contributes nothing.
 */
export function planReadChunks(
  blocks: readonly string[],
  requestLimit: number,
  locale: string,
  targets: Readonly<ChunkTargets> = DEFAULT_CHUNK_TARGETS,
): ChunkPlan {
  const chunks: Chunk[] = [];
  let limit = effectiveLimit(requestLimit);
  for (let blockIndex = 0; blockIndex < blocks.length; blockIndex++) {
    const blockTargets: ChunkTargets =
      chunks.length === 0
        ? targets
        : { first: targets.rest, rest: targets.rest };
    const plan = planChunks(
      blocks[blockIndex],
      requestLimit,
      locale,
      blockTargets,
    );
    limit = plan.limit;
    for (const chunk of plan.chunks) {
      chunks.push({
        index: chunks.length,
        blockIndex,
        text: chunk.text,
        charOffset: chunk.charOffset,
      });
    }
  }
  return { chunks, limit };
}
