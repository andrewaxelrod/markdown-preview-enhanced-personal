import * as fs from 'node:fs';
import * as path from 'node:path';
import { SHA256 } from 'crypto-js';
import type { WordSpan } from './word-spans';

/**
 * On-disk audio cache (F12): instant replay of any chunk already synthesised.
 *
 * Node `fs` only — no `vscode` import, so the class is unit-testable against a
 * temp directory, and no `node:crypto`, because the web bundle stubs it out
 * (precedent `src/markdown-blocks.ts:163`). The controller owns the
 * `context.globalStorageUri` path and hands it in (decision (h)).
 *
 * Every operation is best-effort: a cache failure must never break playback.
 */

/** Directory under `context.globalStorageUri` (F12). */
export const CACHE_DIR_NAME = 'read-aloud-cache';

/**
 * U+001F between the key parts so `'ab' + 'c'` and `'a' + 'bc'` cannot collide
 * (B5 — F12 specifies plain concatenation, which is ambiguous).
 */
export const CACHE_KEY_SEPARATOR = '\u001f';

export interface CacheEntry {
  audioBase64: string;
  spans: WordSpan[] | null;
  mimeType: 'audio/mpeg';
  createdAt: number;
  /**
   * The alignment's audio end in seconds, stored since 14 so a hit can post
   * the same `durationHint` a miss does; entries written before it have only
   * their spans (see {@link cachedDurationHint}).
   */
  durationHint?: number;
}

/**
 * The `durationHint` to post for a cache hit (14): the one stored with the
 * entry, else the end of its last word span, else nothing. Without it the
 * webview knew no length for a cached chunk until its audio loaded, which
 * left the time display short and the timeline of a burst of hits flat.
 */
export function cachedDurationHint(entry: CacheEntry): number | undefined {
  if (
    typeof entry.durationHint === 'number' &&
    Number.isFinite(entry.durationHint) &&
    entry.durationHint > 0
  ) {
    return entry.durationHint;
  }
  if (!entry.spans || entry.spans.length === 0) {
    return undefined;
  }
  let end = 0;
  for (const span of entry.spans) {
    if (Number.isFinite(span.end) && span.end > end) {
      end = span.end;
    }
  }
  return end > 0 ? end : undefined;
}

/**
 * Content, voice and model only, so the same words are a hit wherever they
 * sit: editing a neighbouring block, or starting a read at a different word,
 * never invalidates a chunk that is still spoken the same way.
 */
export interface CacheKeyParts {
  text: string;
  voiceId: string;
  modelId: string;
}

/** SHA-256 hex of the three key parts joined with {@link CACHE_KEY_SEPARATOR}. */
export function cacheKey(parts: CacheKeyParts): string {
  const joined = [parts.text, parts.voiceId, parts.modelId].join(
    CACHE_KEY_SEPARATOR,
  );
  return SHA256(joined).toString();
}

interface CacheFile {
  name: string;
  fullPath: string;
  size: number;
  mtimeMs: number;
}

export class ReadAloudCache {
  private readonly dir: string;
  private maxBytes: number;
  /**
   * Running estimate of the directory size, or `null` until first measured.
   * Lets `set` skip the stat-every-entry scan unless the cap may be exceeded.
   */
  private knownTotal: number | null = null;

  constructor(dir: string, maxBytes: number) {
    this.dir = dir;
    this.maxBytes = Math.max(0, maxBytes);
  }

  /**
   * Read an entry, touching its mtime so the LRU order reflects use. Returns
   * `undefined` on a miss or on any read/parse error.
   */
  public get(key: string): CacheEntry | undefined {
    const file = this.pathFor(key);
    if (!file) {
      return undefined;
    }
    let entry: CacheEntry;
    try {
      entry = JSON.parse(fs.readFileSync(file, 'utf8')) as CacheEntry;
    } catch {
      return undefined;
    }
    if (!entry || typeof entry.audioBase64 !== 'string') {
      return undefined;
    }
    try {
      const now = new Date();
      fs.utimesSync(file, now, now);
    } catch {
      // Touching is best-effort; a hit must not fail on a read-only volume.
    }
    return entry;
  }

  /**
   * Write an entry, then evict the oldest files until the cap is met. The
   * directory is scanned on the first write and whenever the running
   * estimate crosses the cap; every other write is a single file write.
   */
  public set(key: string, entry: CacheEntry): void {
    const file = this.pathFor(key);
    if (!file) {
      return;
    }
    let written: number;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const json = JSON.stringify(entry);
      fs.writeFileSync(file, json, 'utf8');
      // Base64 audio dominates the entry, so code units ≈ bytes.
      written = json.length;
    } catch {
      return;
    }
    if (this.knownTotal === null) {
      this.knownTotal = this.sizeBytes();
    } else {
      this.knownTotal += written;
    }
    if (this.knownTotal > this.maxBytes) {
      this.knownTotal = this.evict(path.basename(file));
    }
  }

  /** Delete every cached entry; returns how many files were removed. */
  public clear(): number {
    let removed = 0;
    for (const file of this.list()) {
      try {
        fs.unlinkSync(file.fullPath);
        removed++;
      } catch {
        // Skip files another process is holding.
      }
    }
    this.knownTotal = null;
    return removed;
  }

  /** Total size of the cache directory in bytes. */
  public sizeBytes(): number {
    return this.list().reduce((total, file) => total + file.size, 0);
  }

  public setMaxBytes(maxBytes: number): void {
    this.maxBytes = Math.max(0, maxBytes);
    this.knownTotal = this.evict();
  }

  private pathFor(key: string): string | undefined {
    if (!/^[0-9a-f]{8,128}$/i.test(key)) {
      return undefined;
    }
    return path.join(this.dir, `${key}.json`);
  }

  private list(): CacheFile[] {
    let names: string[];
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      return [];
    }
    const files: CacheFile[] = [];
    for (const name of names) {
      if (!name.endsWith('.json')) {
        continue;
      }
      const fullPath = path.join(this.dir, name);
      try {
        const stat = fs.statSync(fullPath);
        if (stat.isFile()) {
          files.push({
            name,
            fullPath,
            size: stat.size,
            mtimeMs: stat.mtimeMs,
          });
        }
      } catch {
        // Vanished between readdir and stat — ignore.
      }
    }
    return files;
  }

  /**
   * LRU eviction by file mtime; returns the directory size afterwards.
   * `protect` is never evicted (a just-written entry).
   */
  private evict(protect?: string): number {
    const files = this.list();
    let total = files.reduce((sum, file) => sum + file.size, 0);
    if (total <= this.maxBytes) {
      return total;
    }
    const candidates = files
      .filter((file) => file.name !== protect)
      .sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (const file of candidates) {
      if (total <= this.maxBytes) {
        break;
      }
      try {
        fs.unlinkSync(file.fullPath);
        total -= file.size;
      } catch {
        // Best-effort.
      }
    }
    return total;
  }
}
