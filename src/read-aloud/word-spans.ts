import type { AlignmentWire } from './elevenlabs-types';

/**
 * Character timings -> word spans (F4, R2 §5.2).
 *
 * Pure module: no `vscode`, no I/O. ElevenLabs returns one timing entry per
 * character of the text we sent; the webview highlights whole words, so the
 * grouping happens here, on the extension host, and only the resulting spans
 * travel over `postMessage`.
 */

/** R2 §5.2, spec F13. `charStart`/`charEnd` are UTF-16 code-unit indices. */
export interface WordSpan {
  text: string;
  charStart: number;
  charEnd: number;
  start: number;
  end: number;
}

/** camelCase copy of {@link AlignmentWire}. */
export interface Alignment {
  characters: string[];
  characterStartTimesSeconds: number[];
  characterEndTimesSeconds: number[];
}

/** One word-like segment of the sent text. */
export interface WordSegment {
  index: number;
  segment: string;
}

function isNumberArray(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.every((entry) => typeof entry === 'number' && Number.isFinite(entry))
  );
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === 'string')
  );
}

/**
 * camelCase copy of the wire alignment; `undefined` when the payload is
 * null/absent or when the three arrays are not equal-length, non-empty arrays
 * of the right primitive types.
 */
export function alignmentFromWire(
  wire: AlignmentWire | null | undefined,
): Alignment | undefined {
  if (!wire || typeof wire !== 'object') {
    return undefined;
  }
  const characters = wire.characters;
  const starts = wire.character_start_times_seconds;
  const ends = wire.character_end_times_seconds;
  if (
    !isStringArray(characters) ||
    !isNumberArray(starts) ||
    !isNumberArray(ends)
  ) {
    return undefined;
  }
  if (characters.length === 0) {
    return undefined;
  }
  if (
    characters.length !== starts.length ||
    characters.length !== ends.length
  ) {
    return undefined;
  }
  return {
    characters: characters.slice(),
    characterStartTimesSeconds: starts.slice(),
    characterEndTimesSeconds: ends.slice(),
  };
}

function whitespaceSegments(text: string): WordSegment[] {
  const out: WordSegment[] = [];
  const re = /\S+/g;
  let match = re.exec(text);
  while (match !== null) {
    out.push({ index: match.index, segment: match[0] });
    match = re.exec(text);
  }
  return out;
}

/**
 * `Intl.Segmenter` word granularity, keeping word-like segments only. Falls
 * back to `/\S+/g` when `Intl.Segmenter` is missing or the locale throws
 * (decision (i)).
 */
export function segmentWords(text: string, locale: string): WordSegment[] {
  if (typeof Intl === 'undefined' || typeof Intl.Segmenter !== 'function') {
    return whitespaceSegments(text);
  }
  let segmenter: Intl.Segmenter;
  try {
    segmenter = new Intl.Segmenter(locale, { granularity: 'word' });
  } catch {
    try {
      segmenter = new Intl.Segmenter('en', { granularity: 'word' });
    } catch {
      return whitespaceSegments(text);
    }
  }
  const out: WordSegment[] = [];
  for (const data of segmenter.segment(text)) {
    if (data.isWordLike === true) {
      out.push({ index: data.index, segment: data.segment });
    }
  }
  return out;
}

/**
 * Prefix sums of `characters[i].length` in UTF-16 code units. Length is
 * `characters.length + 1`; `prefix[i]` is the code-unit offset at which
 * `characters[i]` starts.
 */
export function buildCodeUnitIndex(characters: string[]): number[] {
  const prefix: number[] = new Array(characters.length + 1);
  prefix[0] = 0;
  for (let i = 0; i < characters.length; i++) {
    prefix[i + 1] = prefix[i] + characters[i].length;
  }
  return prefix;
}

/**
 * Index `i` such that `prefix[i] <= codeUnit < prefix[i + 1]`; `-1` when the
 * code unit falls outside the covered range. Binary search, so the mapping is
 * cheap whether ElevenLabs emits one entry per code unit or per code point.
 */
export function charIndexAtCodeUnit(
  prefix: number[],
  codeUnit: number,
): number {
  if (
    prefix.length < 2 ||
    codeUnit < prefix[0] ||
    codeUnit >= prefix[prefix.length - 1]
  ) {
    return -1;
  }
  let low = 0;
  let high = prefix.length - 2;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (codeUnit < prefix[mid]) {
      high = mid - 1;
    } else if (codeUnit >= prefix[mid + 1]) {
      low = mid + 1;
    } else {
      return mid;
    }
  }
  return -1;
}

/**
 * Group the alignment's per-character timings into word spans.
 *
 * R2 §5.2 guard 1: returns `undefined` unless `characters.join('') === sentText`,
 * because otherwise the indices are meaningless. Also `undefined` when any
 * looked-up time is not a finite number.
 */
export function toWordSpans(
  sentText: string,
  alignment: Alignment,
  locale: string,
): WordSpan[] | undefined {
  if (alignment.characters.join('') !== sentText) {
    return undefined;
  }
  const prefix = buildCodeUnitIndex(alignment.characters);
  const spans: WordSpan[] = [];
  for (const segment of segmentWords(sentText, locale)) {
    const charStart = segment.index;
    const charEnd = segment.index + segment.segment.length;
    if (charEnd <= charStart) {
      continue;
    }
    const firstChar = charIndexAtCodeUnit(prefix, charStart);
    const lastChar = charIndexAtCodeUnit(prefix, charEnd - 1);
    if (firstChar < 0 || lastChar < 0) {
      return undefined;
    }
    const start = alignment.characterStartTimesSeconds[firstChar];
    let end = alignment.characterEndTimesSeconds[lastChar];
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      return undefined;
    }
    if (end < start) {
      end = start;
    }
    spans.push({ text: segment.segment, charStart, charEnd, start, end });
  }
  return spans;
}
