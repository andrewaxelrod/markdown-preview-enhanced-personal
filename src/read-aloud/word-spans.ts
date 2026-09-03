/**
 * Word spans and word segmentation (F4).
 *
 * Pure module: no `vscode`, no I/O. The webview highlights whole words, so
 * the grouping of the server's timings into words happens on the extension
 * host (`kokoro-alignment.ts`, built on {@link segmentWords}) and only the
 * resulting spans travel over `postMessage`.
 */

/** Spec F13. `charStart`/`charEnd` are UTF-16 code-unit indices. */
export interface WordSpan {
  text: string;
  charStart: number;
  charEnd: number;
  start: number;
  end: number;
}

/** One word-like segment of the sent text. */
export interface WordSegment {
  index: number;
  segment: string;
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
