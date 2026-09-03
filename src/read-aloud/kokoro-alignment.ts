import { segmentWords, type WordSpan } from './word-spans';

/**
 * Kokoro word timestamps -> word spans over the sent text (F4).
 *
 * Pure module: no `vscode`, no I/O.
 *
 * Kokoro-FastAPI returns one timing per *token of its own G2P*, not per
 * character of the text we sent, and those tokens do not line up one-to-one
 * with the webview's `Intl.Segmenter` words:
 *
 * - punctuation is its own token (`.`, `,`, `(`, `"`), which we drop;
 * - a hyphenated or dotted run is one token (`read-aloud`, `2024-09-02`,
 *   `10,000-credit`, `U.S.`) where the segmenter sees two or three words;
 * - the server drops the timestamps of the rest of a chunk after a token with
 *   no phonemes (a bare `$` before a number, seen in practice), so whole runs
 *   of words can be missing while their audio is still there.
 *
 * So the two sequences are aligned by their *folded* text (letters, marks and
 * digits only, case-folded): equal keys match one-to-one, a token whose key is
 * the concatenation of several word keys covers them (its time split in
 * proportion to their length), a word whose key is the concatenation of
 * several token keys spans them, and anything else resyncs on the next equal
 * key within a short window. Words left without a time are interpolated
 * between their timed neighbours, so the highlight keeps moving through a
 * gap instead of freezing on the last timed word.
 */

export interface KokoroWord {
  word: string;
  start: number;
  end: number;
}

export interface KokoroAlignment {
  spans: WordSpan[];
  /** Words that got their time from a Kokoro token, not from interpolation. */
  matched: number;
  /** All word-like segments of the sent text. */
  total: number;
  /** End time of the last Kokoro token, for the webview's duration hint. */
  audioEnd: number;
}

interface Seg {
  index: number;
  segment: string;
  key: string;
}

interface Tok {
  key: string;
  start: number;
  end: number;
}

interface Timed {
  start: number;
  end: number;
}

/** How far ahead a resync looks, in tokens or words. */
const RESYNC_WINDOW = 8;

/**
 * Letters, marks and digits only, NFKC-folded and lower-cased, so `Smith's`
 * and `Smith’s`, `10,000-credit` and `10,000` + `credit`, `U.S.` and `U.S`
 * compare equal.
 */
export function foldForAlignment(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, '');
}

function findAhead<T extends { key: string }>(
  items: T[],
  from: number,
  key: string,
  window: number,
): number {
  const limit = Math.min(items.length, from + window);
  for (let i = from; i < limit; i++) {
    if (items[i].key === key) {
      return i;
    }
  }
  return -1;
}

/**
 * Split `[start, end]` over `segs[from, to)` in proportion to each word's
 * key length (never less than one unit each).
 */
function distribute(
  times: Array<Timed | null>,
  segs: Seg[],
  from: number,
  to: number,
  start: number,
  end: number,
): void {
  const span = Math.max(0, end - start);
  let weightTotal = 0;
  for (let i = from; i < to; i++) {
    weightTotal += Math.max(1, segs[i].key.length);
  }
  let cursor = start;
  for (let i = from; i < to; i++) {
    const weight = Math.max(1, segs[i].key.length);
    const next = i === to - 1 ? end : cursor + (span * weight) / weightTotal;
    times[i] = { start: cursor, end: next };
    cursor = next;
  }
}

/**
 * Two-pointer alignment of the word segments against the Kokoro tokens.
 * Returns the per-segment times (`null` where no token matched) and the
 * number of matched segments.
 */
function alignTimes(
  segs: Seg[],
  toks: Tok[],
): { times: Array<Timed | null>; matched: number } {
  const times: Array<Timed | null> = new Array(segs.length).fill(null);
  let matched = 0;
  let si = 0;
  let ki = 0;
  while (si < segs.length && ki < toks.length) {
    const a = segs[si].key;
    const b = toks[ki].key;
    if (a === b) {
      times[si] = { start: toks[ki].start, end: toks[ki].end };
      matched++;
      si++;
      ki++;
      continue;
    }
    if (b.startsWith(a)) {
      // One token covers several words: `read-aloud` -> `read`, `aloud`.
      let acc = a;
      let sj = si + 1;
      while (
        acc.length < b.length &&
        sj < segs.length &&
        b.startsWith(acc + segs[sj].key)
      ) {
        acc += segs[sj].key;
        sj++;
      }
      if (acc === b) {
        distribute(times, segs, si, sj, toks[ki].start, toks[ki].end);
        matched += sj - si;
        si = sj;
        ki++;
        continue;
      }
    }
    if (a.startsWith(b)) {
      // One word spans several tokens.
      let acc = b;
      let kj = ki + 1;
      while (
        acc.length < a.length &&
        kj < toks.length &&
        a.startsWith(acc + toks[kj].key)
      ) {
        acc += toks[kj].key;
        kj++;
      }
      if (acc === a) {
        times[si] = { start: toks[ki].start, end: toks[kj - 1].end };
        matched++;
        si++;
        ki = kj;
        continue;
      }
    }
    // Resync on the nearest equal key ahead: skip extra tokens first, else
    // leave our words untimed (interpolated below), else skip both.
    const kFound = findAhead(toks, ki + 1, a, RESYNC_WINDOW);
    const sFound = findAhead(segs, si + 1, b, RESYNC_WINDOW);
    if (kFound >= 0 && (sFound < 0 || kFound - ki <= sFound - si)) {
      ki = kFound;
      continue;
    }
    if (sFound >= 0) {
      si = sFound;
      continue;
    }
    si++;
    ki++;
  }
  return { times, matched };
}

/**
 * Give every untimed word a time between its timed neighbours, in proportion
 * to word length. A leading run starts at the beginning of the audio; a
 * trailing run ends at the last token's end.
 */
function interpolate(
  times: Array<Timed | null>,
  segs: Seg[],
  audioEnd: number,
): void {
  let i = 0;
  while (i < times.length) {
    if (times[i] !== null) {
      i++;
      continue;
    }
    let j = i;
    while (j < times.length && times[j] === null) {
      j++;
    }
    const prev = i > 0 ? (times[i - 1] as Timed) : null;
    const next = j < times.length ? (times[j] as Timed) : null;
    const start = prev ? prev.end : 0;
    let end = next ? next.start : Math.max(audioEnd, start);
    if (end < start) {
      end = start;
    }
    distribute(times, segs, i, j, start, end);
    i = j;
  }
}

/**
 * Align Kokoro's word timestamps with the word-like segments of `sentText`.
 *
 * `undefined` when the text has no words, when there are no usable tokens,
 * or when not a single word could be matched: the audio then plays with no
 * word highlight and a line in the output channel.
 */
export function alignKokoroWords(
  sentText: string,
  words: KokoroWord[],
  locale: string,
): KokoroAlignment | undefined {
  const segs: Seg[] = [];
  for (const segment of segmentWords(sentText, locale)) {
    const key = foldForAlignment(segment.segment);
    if (key.length === 0) {
      continue;
    }
    segs.push({ index: segment.index, segment: segment.segment, key });
  }
  const toks: Tok[] = [];
  // Punctuation tokens carry no word but their time is real audio (the
  // pause), so the audio end is taken over every valid token.
  let audioEnd = 0;
  for (const word of words) {
    if (
      !word ||
      typeof word.word !== 'string' ||
      !Number.isFinite(word.start) ||
      !Number.isFinite(word.end)
    ) {
      continue;
    }
    const end = Math.max(word.start, word.end);
    audioEnd = Math.max(audioEnd, end);
    const key = foldForAlignment(word.word);
    if (key.length === 0) {
      continue;
    }
    toks.push({ key, start: word.start, end });
  }
  if (segs.length === 0 || toks.length === 0) {
    return undefined;
  }

  const { times, matched } = alignTimes(segs, toks);
  if (matched === 0) {
    return undefined;
  }
  interpolate(times, segs, audioEnd);

  const spans: WordSpan[] = [];
  for (let i = 0; i < segs.length; i++) {
    const timed = times[i] as Timed;
    spans.push({
      text: segs[i].segment,
      charStart: segs[i].index,
      charEnd: segs[i].index + segs[i].segment.length,
      start: timed.start,
      end: Math.max(timed.start, timed.end),
    });
  }
  return { spans, matched, total: segs.length, audioEnd };
}
