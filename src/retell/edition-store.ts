import * as fs from 'fs';
import * as path from 'path';
import {
  documentKeyFor,
  fileNameFor,
  newNoteId,
  NO_WORKSPACE_FOLDER,
  noteIdOfFileName,
  safeSegment,
  segmentsOf,
  type DocumentKey,
} from '../notes/notes-store';
import {
  isEditionParseError,
  parseEditionFile,
  serializeEditionFile,
  type EditionParseError,
  type ParsedEdition,
} from './edition-format';

/**
 * The edition store (`featrues/15-convert-readable/spec.md` §11): one `.md`
 * per spoken edition under `<root>/editions/<workspace folder key>/<relative
 * path>/`, a separate root from the classroom's (D15) so neither store's
 * recognition or markers ever sees the other's files; atomic writes,
 * per-file serialisation, a re-read before every rewrite, the notes store's
 * debounced watcher that ignores its own writes, and a soft delete that ends
 * in the OS trash (§11.3). `ModuleStore`'s class with `modules/` →
 * `editions/` and no persona folders.
 *
 * Node `fs` only, root injected: no `vscode` here, so the whole thing runs
 * against a temp directory in `test/retell/edition-store.test.js`.
 */

export const EDITIONS_DIR_NAME = 'editions';
export const LIST_ALL_CAP = 500;
export const RECENT_WRITE_MS = 1000;
export const WATCH_DEBOUNCE_MS = 300;

export { documentKeyFor, NO_WORKSPACE_FOLDER };
export type { DocumentKey };

export interface EditionRecord extends ParsedEdition {
  filePath: string;
  key: DocumentKey;
}

export interface EditionListing {
  editions: EditionRecord[];
  unreadable: string[];
}

export type WatchFn = (
  dir: string,
  listener: (eventType: string, fileName: string | Buffer | null) => void,
) => { close(): void };

export interface EditionStoreDeps {
  root: string;
  log: (line: string) => void;
  now?: () => Date;
  randomHex?: () => string;
  /** Move a file to the OS trash; resolve false (or throw) when refused. Absent: permanent. */
  trash?: (filePath: string) => Promise<boolean>;
  watch?: WatchFn;
}

interface Watcher {
  dir: string;
  onChange: () => void;
  handle: { close(): void } | null;
  timer: ReturnType<typeof setTimeout> | null;
  disposed: boolean;
}

interface SoftDelete {
  key: DocumentKey;
  editionId: string;
  timer: ReturnType<typeof setTimeout>;
  resolve: (outcome: DeleteOutcome) => void;
}

export type DeleteOutcome = 'trash' | 'permanent' | 'undone' | 'missing';

export class EditionUnreadableError extends Error {
  public readonly filePath: string;
  constructor(filePath: string, reason: string) {
    super(`The edition file could not be updated (${reason})`);
    this.name = 'EditionUnreadableError';
    this.filePath = filePath;
  }
}

export class EditionMissingError extends Error {
  constructor(editionId: string) {
    super(`No edition file for ${editionId}`);
    this.name = 'EditionMissingError';
  }
}

function defaultRandomHex(): string {
  const bytes = new Uint8Array(2);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** §11.2 — the slug comes from the first unit's heading, else the document's title. */
export function editionFileName(edition: ParsedEdition): string {
  const first = edition.sections.length ? edition.sections[0].heading : '';
  return fileNameFor(edition.id, first || edition.document.title);
}

export class EditionStore {
  public readonly root: string;
  private readonly deps: EditionStoreDeps;
  private readonly chains = new Map<string, Promise<unknown>>();
  private readonly recentWrites = new Map<string, number>();
  private readonly watchers = new Set<Watcher>();
  private readonly deleting = new Map<string, SoftDelete>();

  constructor(deps: EditionStoreDeps) {
    this.deps = deps;
    this.root = deps.root;
  }

  // ------------------------------------------------------------- paths

  public get editionsRoot(): string {
    return path.join(this.root, EDITIONS_DIR_NAME);
  }

  public folderDir(folderKey: string): string {
    return path.join(this.editionsRoot, safeSegment(folderKey));
  }

  public documentDir(key: DocumentKey): string {
    return path.join(this.folderDir(key.folder), ...segmentsOf(key.document));
  }

  /** The file of `editionId` in the document's folder, by id prefix, or null. */
  public find(key: DocumentKey, editionId: string): string | null {
    const dir = this.documentDir(key);
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return null;
    }
    for (const name of names) {
      if (noteIdOfFileName(name) === editionId) {
        return path.join(dir, name);
      }
    }
    return null;
  }

  /** §11.2 — whether a path is an edition file under this root. */
  public isEditionPath(fsPath: string): boolean {
    const relative = path.relative(this.editionsRoot, path.resolve(fsPath));
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      return false;
    }
    const name = path.basename(fsPath);
    return noteIdOfFileName(name) !== null;
  }

  /** The document key an edition file's location stands for, or null. */
  public keyOf(fsPath: string): DocumentKey | null {
    if (!this.isEditionPath(fsPath)) {
      return null;
    }
    const relative = path.relative(this.editionsRoot, path.resolve(fsPath));
    const segments = relative.split(path.sep);
    if (segments.length < 3) {
      return null;
    }
    return {
      folder: segments[0],
      document: segments.slice(1, -1).join('/'),
    };
  }

  // ------------------------------------------------------------ writing

  /** §11.2 — atomic: `.<name>.tmp` beside the target, then a rename over it. */
  private writeAtomic(filePath: string, content: string): void {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, `.${path.basename(filePath)}.tmp`);
    // Remembered for a second so the watcher never reports our own write.
    this.recentWrites.set(path.basename(filePath), Date.now());
    this.recentWrites.set(path.basename(tmp), Date.now());
    try {
      fs.writeFileSync(tmp, content, 'utf8');
      fs.renameSync(tmp, filePath);
    } catch (error) {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        /* nothing to clean */
      }
      throw error;
    }
  }

  private serialised<T>(
    filePath: string,
    fn: () => T | Promise<T>,
  ): Promise<T> {
    const previous = this.chains.get(filePath) ?? Promise.resolve();
    const next = previous.then(fn, fn);
    const settled = next.then(
      () => undefined,
      () => undefined,
    );
    this.chains.set(filePath, settled);
    void settled.then(() => {
      if (this.chains.get(filePath) === settled) {
        this.chains.delete(filePath);
      }
    });
    return next;
  }

  public newId(): string {
    const now = this.deps.now ? this.deps.now() : new Date();
    const random = this.deps.randomHex
      ? this.deps.randomHex()
      : defaultRandomHex();
    return newNoteId(now, random);
  }

  /** Write a new edition; the file name is the id plus the first unit's slug. */
  public async create(
    key: DocumentKey,
    edition: ParsedEdition,
  ): Promise<EditionRecord> {
    const dir = this.documentDir(key);
    const filePath = path.join(dir, editionFileName(edition));
    return this.serialised(filePath, () => {
      this.writeAtomic(filePath, serializeEditionFile(edition));
      this.attachPendingWatchers(dir);
      return { ...edition, filePath, key };
    });
  }

  public read(filePath: string): ParsedEdition | EditionParseError {
    let text: string;
    try {
      text = fs.readFileSync(filePath, 'utf8');
    } catch (error) {
      return { error: `cannot read: ${String(error)}` };
    }
    return parseEditionFile(text);
  }

  /** The record of one edition, or null when it is gone or unreadable. */
  public get(key: DocumentKey, editionId: string): EditionRecord | null {
    const filePath = this.find(key, editionId);
    if (!filePath) {
      return null;
    }
    const parsed = this.read(filePath);
    return isEditionParseError(parsed) ? null : { ...parsed, filePath, key };
  }

  /**
   * §11.2 — rewrite one edition: re-read, apply `mutate`, write atomically,
   * serialised per file. `mutate` may return null to leave the file alone.
   */
  public async update(
    key: DocumentKey,
    editionId: string,
    mutate: (edition: ParsedEdition) => ParsedEdition | null,
  ): Promise<EditionRecord> {
    const filePath = this.find(key, editionId);
    if (!filePath) {
      throw new EditionMissingError(editionId);
    }
    return this.updatePath(filePath, key, mutate);
  }

  public async updatePath(
    filePath: string,
    key: DocumentKey,
    mutate: (edition: ParsedEdition) => ParsedEdition | null,
  ): Promise<EditionRecord> {
    return this.serialised(filePath, () => {
      const current = this.read(filePath);
      if (isEditionParseError(current)) {
        throw new EditionUnreadableError(filePath, current.error);
      }
      const next = mutate(current);
      if (!next) {
        return { ...current, filePath, key };
      }
      this.writeAtomic(filePath, serializeEditionFile(next));
      return { ...next, filePath, key };
    });
  }

  // ------------------------------------------------------------ listing

  /** §11.2 — every readable edition of a document, newest first. */
  public list(key: DocumentKey): EditionListing {
    return this.listDir(this.documentDir(key), key);
  }

  private listDir(dir: string, key: DocumentKey): EditionListing {
    const editions: EditionRecord[] = [];
    const unreadable: string[] = [];
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return { editions, unreadable };
    }
    for (const name of names) {
      if (!noteIdOfFileName(name) || name.startsWith('.')) {
        continue;
      }
      const filePath = path.join(dir, name);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(filePath);
      } catch {
        continue;
      }
      if (!stat.isFile()) {
        continue;
      }
      const parsed = this.read(filePath);
      if (isEditionParseError(parsed)) {
        unreadable.push(filePath);
        continue;
      }
      editions.push({ ...parsed, filePath, key });
    }
    editions.sort((a, b) =>
      a.created < b.created ? 1 : a.created > b.created ? -1 : 0,
    );
    if (unreadable.length) {
      this.deps.log(
        `retell: ${unreadable.length} unreadable edition file(s) under ${dir}`,
      );
    }
    return { editions, unreadable };
  }

  /** §13 — every edition under `editions/`, for the quick pick, capped. */
  public listAll(): EditionListing & { truncated: boolean } {
    const editions: EditionRecord[] = [];
    const unreadable: string[] = [];
    let truncated = false;
    const walk = (
      dir: string,
      folderKey: string,
      segments: string[],
      depth: number,
    ) => {
      if (truncated || depth > 32) {
        return;
      }
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      const hasEditions = entries.some(
        (entry) => entry.isFile() && noteIdOfFileName(entry.name),
      );
      if (hasEditions) {
        const listing = this.listDir(dir, {
          folder: folderKey,
          document: segments.join('/'),
        });
        unreadable.push(...listing.unreadable);
        for (const edition of listing.editions) {
          if (editions.length >= LIST_ALL_CAP) {
            truncated = true;
            break;
          }
          editions.push(edition);
        }
      }
      for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith('.')) {
          walk(
            path.join(dir, entry.name),
            folderKey,
            [...segments, entry.name],
            depth + 1,
          );
        }
      }
    };
    let folders: fs.Dirent[];
    try {
      folders = fs.readdirSync(this.editionsRoot, { withFileTypes: true });
    } catch {
      return { editions, unreadable, truncated };
    }
    for (const folder of folders) {
      if (folder.isDirectory() && !folder.name.startsWith('.')) {
        walk(path.join(this.editionsRoot, folder.name), folder.name, [], 0);
      }
    }
    if (truncated) {
      this.deps.log(
        `retell: listAll stopped at ${LIST_ALL_CAP} editions under ${this.editionsRoot}`,
      );
    }
    editions.sort((a, b) =>
      a.created < b.created ? 1 : a.created > b.created ? -1 : 0,
    );
    return { editions, unreadable, truncated };
  }

  /** §12.2 — the edition a preview's file is, or null for any other file. */
  public editionAt(fsPath: string): EditionRecord | null {
    const key = this.keyOf(fsPath);
    if (!key) {
      return null;
    }
    const parsed = this.read(path.resolve(fsPath));
    return isEditionParseError(parsed)
      ? null
      : { ...parsed, filePath: path.resolve(fsPath), key };
  }

  // ----------------------------------------------------------- watching

  /**
   * §11.2 — watch one document's edition folder, debounced, own writes
   * ignored. A folder that does not exist yet is watched from the store's
   * first write into it. Best effort: a refused watch logs one line.
   */
  public watch(key: DocumentKey, onChange: () => void): { dispose(): void } {
    const watcher: Watcher = {
      dir: this.documentDir(key),
      onChange,
      handle: null,
      timer: null,
      disposed: false,
    };
    this.watchers.add(watcher);
    this.attach(watcher);
    return {
      dispose: () => {
        watcher.disposed = true;
        this.watchers.delete(watcher);
        if (watcher.timer) {
          clearTimeout(watcher.timer);
          watcher.timer = null;
        }
        if (watcher.handle) {
          try {
            watcher.handle.close();
          } catch {
            /* already closed */
          }
          watcher.handle = null;
        }
      },
    };
  }

  private attach(watcher: Watcher): void {
    if (watcher.disposed || watcher.handle || !fs.existsSync(watcher.dir)) {
      return;
    }
    const watchFn: WatchFn =
      this.deps.watch ??
      ((dir, listener) =>
        fs.watch(dir, (eventType, fileName) => listener(eventType, fileName)));
    try {
      watcher.handle = watchFn(watcher.dir, (_eventType, fileName) => {
        const name =
          typeof fileName === 'string'
            ? fileName
            : fileName
              ? fileName.toString()
              : '';
        if (name && this.isRecentWrite(name)) {
          return;
        }
        if (name && !/\.md$/i.test(name) && !name.endsWith('.tmp')) {
          return;
        }
        if (watcher.timer) {
          clearTimeout(watcher.timer);
        }
        watcher.timer = setTimeout(() => {
          watcher.timer = null;
          if (!watcher.disposed) {
            watcher.onChange();
          }
        }, WATCH_DEBOUNCE_MS);
      });
    } catch (error) {
      watcher.handle = null;
      this.deps.log(`retell: watch failed ${watcher.dir}: ${String(error)}`);
    }
  }

  private attachPendingWatchers(dir: string): void {
    for (const watcher of this.watchers) {
      if (!watcher.handle && watcher.dir === dir) {
        this.attach(watcher);
      }
    }
  }

  private isRecentWrite(fileName: string): boolean {
    const at = this.recentWrites.get(fileName);
    if (at === undefined) {
      return false;
    }
    if (Date.now() - at > RECENT_WRITE_MS) {
      this.recentWrites.delete(fileName);
      return false;
    }
    return true;
  }

  // ------------------------------------------------------------ deleting

  /**
   * §11.3 — soft first: the edition is marked for `delayMs`, during which
   * {@link undoDelete} clears the mark with the file never touched. When the
   * window closes the file goes to the trash through the injected callback,
   * or is deleted permanently when there is none or it refuses.
   */
  public softDelete(
    key: DocumentKey,
    editionId: string,
    delayMs: number,
  ): Promise<DeleteOutcome> {
    const existing = this.deleting.get(editionId);
    if (existing) {
      clearTimeout(existing.timer);
      existing.resolve('undone');
    }
    return new Promise((resolve) => {
      const entry: SoftDelete = {
        key,
        editionId,
        resolve,
        timer: setTimeout(() => {
          void this.finishDelete(entry);
        }, delayMs),
      };
      this.deleting.set(editionId, entry);
    });
  }

  public undoDelete(editionId: string): boolean {
    const entry = this.deleting.get(editionId);
    if (!entry) {
      return false;
    }
    clearTimeout(entry.timer);
    this.deleting.delete(editionId);
    entry.resolve('undone');
    return true;
  }

  public isDeleting(editionId: string): boolean {
    return this.deleting.has(editionId);
  }

  public deletingIds(): string[] {
    return Array.from(this.deleting.keys());
  }

  private async trashOrRemove(
    filePath: string,
  ): Promise<'trash' | 'permanent'> {
    this.recentWrites.set(path.basename(filePath), Date.now());
    let trashed = false;
    if (this.deps.trash) {
      try {
        trashed = await this.deps.trash(filePath);
      } catch (error) {
        this.deps.log(`retell: trash refused ${filePath}: ${String(error)}`);
        trashed = false;
      }
    }
    if (trashed) {
      return 'trash';
    }
    fs.rmSync(filePath, { force: true });
    return 'permanent';
  }

  private async finishDelete(entry: SoftDelete): Promise<void> {
    if (this.deleting.get(entry.editionId) !== entry) {
      return;
    }
    this.deleting.delete(entry.editionId);
    const filePath = this.find(entry.key, entry.editionId);
    if (!filePath) {
      entry.resolve('missing');
      return;
    }
    const outcome = await this.serialised(filePath, () =>
      this.trashOrRemove(filePath),
    );
    entry.resolve(outcome);
  }

  /** Delete at once, no window: the trash first, permanent when refused. */
  public async deleteNow(
    key: DocumentKey,
    editionId: string,
  ): Promise<'trash' | 'permanent' | 'missing'> {
    const existing = this.deleting.get(editionId);
    if (existing) {
      clearTimeout(existing.timer);
      this.deleting.delete(editionId);
      existing.resolve('undone');
    }
    const filePath = this.find(key, editionId);
    if (!filePath) {
      return 'missing';
    }
    return this.serialised(filePath, () => this.trashOrRemove(filePath));
  }

  public dispose(): void {
    for (const watcher of Array.from(this.watchers)) {
      watcher.disposed = true;
      if (watcher.timer) {
        clearTimeout(watcher.timer);
      }
      if (watcher.handle) {
        try {
          watcher.handle.close();
        } catch {
          /* already closed */
        }
      }
    }
    this.watchers.clear();
    for (const entry of Array.from(this.deleting.values())) {
      clearTimeout(entry.timer);
      void this.finishDelete(entry);
    }
  }
}
