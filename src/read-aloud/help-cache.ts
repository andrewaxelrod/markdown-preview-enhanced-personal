import * as fs from 'node:fs';
import * as path from 'node:path';
import { SHA256 } from 'crypto-js';
import { HELP_PROMPT_VERSION } from './help-prompt';

/**
 * On-disk cache of help answers (`featrues/04-help-module.md` §7.4).
 *
 * The shape of `cache.ts`, with two differences: the value is markdown rather
 * than audio, so entries are small and the cap is a count (200, D10) instead
 * of a byte budget; and the key carries the prompt version, the engine, the
 * model and the effort, so nothing written for one configuration is served for
 * another.
 *
 * Node `fs` only — no `vscode` import, so the class is unit-testable against a
 * temp directory, and no `node:crypto`, because the web bundle stubs it out.
 * Every operation is best-effort: a cache failure must never break the sheet.
 */

/** Directory under `context.globalStorageUri`, beside the audio cache. */
export const HELP_CACHE_DIR_NAME = 'read-aloud-help-cache';

/** D10 — how many answers are kept before the oldest is evicted. */
export const HELP_CACHE_MAX_ENTRIES = 200;

/** U+001F between the parts, so two different keys cannot concatenate alike. */
export const HELP_CACHE_KEY_SEPARATOR = '\u001f';

export interface HelpCacheEntry {
  markdown: string;
  engine: string;
  model: string;
  effort: string;
  createdAt: number;
}

/** §7.4 — every input that can change the answer. */
export interface HelpCacheKeyParts {
  engine: string;
  model: string;
  effort: string;
  audience: string;
  contextMode: string;
  title: string;
  breadcrumb: string;
  before: string;
  passage: string;
  after: string;
  section: string;
  question: string;
  previous: string;
}

export function helpCacheKey(parts: HelpCacheKeyParts): string {
  const joined = [
    String(HELP_PROMPT_VERSION),
    parts.engine,
    parts.model,
    parts.effort,
    parts.audience,
    parts.contextMode,
    parts.title,
    parts.breadcrumb,
    parts.before,
    parts.passage,
    parts.after,
    parts.section,
    parts.question,
    parts.previous,
  ].join(HELP_CACHE_KEY_SEPARATOR);
  return SHA256(joined).toString();
}

interface HelpCacheFile {
  name: string;
  fullPath: string;
  mtimeMs: number;
}

export class ReadAloudHelpCache {
  private readonly dir: string;
  private readonly maxEntries: number;

  constructor(dir: string, maxEntries: number = HELP_CACHE_MAX_ENTRIES) {
    this.dir = dir;
    this.maxEntries = Math.max(0, maxEntries);
  }

  /**
   * Read an entry, touching its mtime so the LRU order reflects use. Returns
   * `undefined` on a miss or on any read/parse error.
   */
  public get(key: string): HelpCacheEntry | undefined {
    const file = this.pathFor(key);
    if (!file) {
      return undefined;
    }
    let entry: HelpCacheEntry;
    try {
      entry = JSON.parse(fs.readFileSync(file, 'utf8')) as HelpCacheEntry;
    } catch {
      return undefined;
    }
    if (!entry || typeof entry.markdown !== 'string' || !entry.markdown) {
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

  /** Write an entry, then evict the oldest until the count cap is met. */
  public set(key: string, entry: HelpCacheEntry): void {
    const file = this.pathFor(key);
    if (!file) {
      return;
    }
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(entry), 'utf8');
    } catch {
      return;
    }
    this.evict(path.basename(file));
  }

  /** Delete every cached answer; returns how many files were removed. */
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
    return removed;
  }

  public size(): number {
    return this.list().length;
  }

  private pathFor(key: string): string | undefined {
    if (!/^[0-9a-f]{8,128}$/i.test(key)) {
      return undefined;
    }
    return path.join(this.dir, `${key}.json`);
  }

  private list(): HelpCacheFile[] {
    let names: string[];
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      return [];
    }
    const files: HelpCacheFile[] = [];
    for (const name of names) {
      if (!name.endsWith('.json')) {
        continue;
      }
      const fullPath = path.join(this.dir, name);
      try {
        const stat = fs.statSync(fullPath);
        if (stat.isFile()) {
          files.push({ name, fullPath, mtimeMs: stat.mtimeMs });
        }
      } catch {
        // Vanished between readdir and stat — ignore.
      }
    }
    return files;
  }

  /** LRU eviction by file mtime; `protect` is never evicted. */
  private evict(protect?: string): void {
    const files = this.list();
    if (files.length <= this.maxEntries) {
      return;
    }
    const candidates = files
      .filter((file) => file.name !== protect)
      .sort((a, b) => a.mtimeMs - b.mtimeMs);
    let total = files.length;
    for (const file of candidates) {
      if (total <= this.maxEntries) {
        break;
      }
      try {
        fs.unlinkSync(file.fullPath);
        total--;
      } catch {
        // Best-effort.
      }
    }
  }
}
