/**
 * `Intl.Segmenter` is an ES2022 library type, but `tsconfig.json:8-11` pins
 * `lib` to `["ES2020", "WebWorker"]`, so `TS2339: Property 'Segmenter' does not
 * exist on type 'typeof Intl'` without this declaration. The runtime has it:
 * Node 16+ and Chrome 87+ ship it, and VS Code 1.82 runs Node 18.15.
 *
 * Declared here rather than by widening `lib`, so nothing else in the repo
 * changes its type surface. Precedent: `src/types/pi-ai.d.ts`.
 */
declare namespace Intl {
  type SegmenterGranularity = 'grapheme' | 'word' | 'sentence';
  interface SegmenterOptions {
    localeMatcher?: 'lookup' | 'best fit';
    granularity?: SegmenterGranularity;
  }
  interface SegmentData {
    segment: string;
    index: number;
    input: string;
    isWordLike?: boolean;
  }
  interface Segments {
    containing(codeUnitIndex?: number): SegmentData | undefined;
    [Symbol.iterator](): IterableIterator<SegmentData>;
  }
  interface Segmenter {
    segment(input: string): Segments;
    resolvedOptions(): { locale: string; granularity: SegmenterGranularity };
  }
  const Segmenter: {
    prototype: Segmenter;
    new (locales?: string | string[], options?: SegmenterOptions): Segmenter;
    supportedLocalesOf(
      locales: string | string[],
      options?: { localeMatcher?: 'lookup' | 'best fit' },
    ): string[];
  };
}
