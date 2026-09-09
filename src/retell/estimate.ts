/**
 * The estimate (`featrues/15-convert-readable/spec.md` §7): how long a spoken
 * edition is likely to be, and how long it takes to hear.
 *
 * Every constant is a measurement, not a preference. The ratio is the mean of
 * the four low-effort runs of `featrues/15-convert-readable/experiment/`
 * (1.24, 1.24, 1.58, 1.48), which it is within 15 % of on every one; the
 * ceiling is a runaway guard above the highest run measured (1.41); the lower
 * bound is a soft signal that content was dropped, below the lowest run; the
 * words a minute are Kokoro `af_heart` at 1× over this section's own prose
 * (137 words in 58.1 s). `WORDS_PER_MINUTE = 150` in
 * `src/classroom/module-format.ts` is the classroom's and stays as it is (D22).
 *
 * Pure module: no `vscode`, no I/O.
 */

/** §7 — the edition is about this many times the source's words. */
export const RETELL_ESTIMATE_RATIO = 1.4;

/** §7 — above this many times the source the build retries once (`length-over`). */
export const RETELL_CEILING_RATIO = 1.8;

/** §7, D21 — below this many times the source is a soft `length-under`. */
export const RETELL_UNDER_RATIO = 0.8;

/** §7 — Kokoro `af_heart` at 1×, measured on this prose. */
export const RETELL_WORDS_PER_MINUTE = 142;

export interface RetellEstimate {
  /** Rounded to ten words. */
  words: number;
  /** Never 0: a section that exists takes at least a minute to hear. */
  minutes: number;
}

/** The minutes an edition of `words` words takes at 1×; never 0. */
export function minutesFor(words: number): number {
  const count = Number.isFinite(words) && words > 0 ? words : 0;
  return Math.max(1, Math.round(count / RETELL_WORDS_PER_MINUTE));
}

/** §7 — `words = round(1.4 × sourceWords / 10) × 10`, `minutes = max(1, round(words / 142))`. */
export function estimateFor(sourceWords: number): RetellEstimate {
  const source =
    Number.isFinite(sourceWords) && sourceWords > 0 ? sourceWords : 0;
  const words = Math.round((RETELL_ESTIMATE_RATIO * source) / 10) * 10;
  return { words, minutes: minutesFor(words) };
}

/** §7 — the runaway ceiling, `round(1.8 × sourceWords)`. */
export function ceilingFor(sourceWords: number): number {
  const source =
    Number.isFinite(sourceWords) && sourceWords > 0 ? sourceWords : 0;
  return Math.round(RETELL_CEILING_RATIO * source);
}

/** §7, D21 — the soft lower bound, `round(0.8 × sourceWords)`. */
export function underFor(sourceWords: number): number {
  const source =
    Number.isFinite(sourceWords) && sourceWords > 0 ? sourceWords : 0;
  return Math.round(RETELL_UNDER_RATIO * source);
}
