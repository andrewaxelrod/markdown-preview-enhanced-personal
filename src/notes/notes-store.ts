import * as fs from 'fs';
import * as path from 'path';
import {
  isParseError,
  parseNoteFile,
  serializeNoteFile,
  type NoteParseError,
  type ParsedNote,
} from './note-format';

/**
 * The notes store (`featrues/12-notes/spec.md` §7): one `.md` per note under
 * `<root>/<workspace folder>/<workspace-relative path>/`, the directory
 * listing as the index, atomic writes, per-file serialisation, a re-read
 * before every rewrite, a debounced watcher that ignores its own writes, and
 * a soft delete that ends in the OS trash.
 *
 * Node `fs` only, root injected: no `vscode` here, so the whole thing runs
 * against a temp directory in `test/notes/notes-store.test.js`.
 */

export const NO_WORKSPACE_FOLDER = '_no-workspace';
export const FOLDER_MARKER = '.folder';
export const SLUG_MAX_CHARS = 40;
export const RECENT_WRITE_MS = 1000;
export const WATCH_DEBOUNCE_MS = 300;
export const LIST_ALL_CAP = 2000;
export const NOTE_FILE_RE = /^(\d{8}T\d{6}Z-[0-9a-f]{4})(?:-[a-z0-9-]*)?\.md$/;

export interface DocumentKey {
  /** The workspace folder's key: its name, suffixed on a name collision. */
  folder: string;
  /** The document's path relative to the folder, extension included. */
  document: string;
}

export interface WorkspaceFolderLike {
  name: string;
  fsPath: string;
}

export interface NoteRecord extends ParsedNote {
  filePath: string;
}

export interface NoteListing {
  notes: NoteRecord[];
  unreadable: string[];
}

export interface DocumentListing {
  key: DocumentKey;
  dir: string;
  count: number;
}

export type WatchFn = (
  dir: string,
  listener: (eventType: string, fileName: string | Buffer | null) => void,
) => { close(): void };

export interface NotesStoreDeps {
  root: string;
  log: (line: string) => void;
  /** Move a file to the OS trash; resolve false (or throw) when refused. */
  trash: (filePath: string) => Promise<boolean>;
  now?: () => Date;
  /** Four lowercase hex characters for the id; `crypto` by default. */
  randomHex?: () => string;
  watch?: WatchFn;
}

export class NoteUnreadableError extends Error {
  public readonly filePath: string;
  constructor(filePath: string, reason: string) {
    super(
      `The note file could not be updated; open it to check it (${reason})`,
    );
    this.name = 'NoteUnreadableError';
    this.filePath = filePath;
  }
}

export class NoteMissingError extends Error {
  constructor(noteId: string) {
    super(`No note file for ${noteId}`);
    this.name = 'NoteMissingError';
  }
}

// -------------------------------------------------------------- identity

/** 32-bit FNV-1a as six hex characters; the same hash the webview keys blocks by. */
function shortHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash.toString(16).padStart(8, '0').slice(0, 6);
}

/** A folder or file name that is safe on every filesystem the store may sit on. */
export function safeSegment(segment: string): string {
  // The characters Windows refuses, and control characters; the name itself
  // — spaces and hyphens included — is kept, because it is the key.
  // eslint-disable-next-line no-control-regex
  const cleaned = segment.replace(/[<>:"|?*\x00-\x1f]/g, '_').trim();
  return cleaned === '' || cleaned === '.' || cleaned === '..' ? '_' : cleaned;
}

/**
 * §7.2 — the key of a workspace folder: its name, or its name plus a short
 * hash of its absolute path when an earlier folder of the window has the same
 * name (two clones of one repository side by side).
 */
export function workspaceFolderKey(
  folder: WorkspaceFolderLike,
  all: readonly WorkspaceFolderLike[],
): string {
  const name = safeSegment(folder.name) || NO_WORKSPACE_FOLDER;
  for (const other of all) {
    if (other.fsPath === folder.fsPath) {
      break;
    }
    if (safeSegment(other.name) === name) {
      return `${name}-${shortHash(folder.fsPath)}`;
    }
  }
  return name;
}

/** A path split on either separator, each segment made safe, empties dropped. */
export function segmentsOf(relative: string): string[] {
  return relative
    .split(/[\\/]+/)
    .filter((part) => part.length > 0)
    .map(safeSegment);
}

/**
 * §7.2 — the document key: the workspace folder's key plus the
 * workspace-relative path; with no folder, `_no-workspace` plus the absolute
 * path without its leading separator (and without a drive colon on Windows).
 */
export function documentKeyFor(input: {
  folder: WorkspaceFolderLike | null;
  relativePath: string;
  absolutePath: string;
  folders: readonly WorkspaceFolderLike[];
}): DocumentKey {
  if (input.folder) {
    return {
      folder: workspaceFolderKey(input.folder, input.folders),
      document: segmentsOf(input.relativePath).join('/'),
    };
  }
  const absolute = input.absolutePath.replace(/^([A-Za-z]):/, '$1');
  return {
    folder: NO_WORKSPACE_FOLDER,
    document: segmentsOf(absolute).join('/'),
  };
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

/** §7.2 — `YYYYMMDDTHHMMSSZ-xxxx`. */
export function newNoteId(now: Date, randomHex: string): string {
  const stamp =
    `${pad(now.getUTCFullYear(), 4)}${pad(now.getUTCMonth() + 1, 2)}${pad(now.getUTCDate(), 2)}` +
    `T${pad(now.getUTCHours(), 2)}${pad(now.getUTCMinutes(), 2)}${pad(now.getUTCSeconds(), 2)}Z`;
  const suffix = (randomHex || '').toLowerCase().replace(/[^0-9a-f]/g, '');
  return `${stamp}-${(suffix + '0000').slice(0, 4)}`;
}

/** §7.2 — the first three words of the passage as a slug, at most 40 characters. */
export function slugFor(passage: string): string {
  const words = (passage || '')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 3);
  return words
    .join(' ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX_CHARS)
    .replace(/-+$/g, '');
}

export function fileNameFor(id: string, passage: string): string {
  const slug = slugFor(passage);
  return slug ? `${id}-${slug}.md` : `${id}.md`;
}

/** The id at the front of a note file name, or null for any other file. */
export function noteIdOfFileName(fileName: string): string | null {
  const match = NOTE_FILE_RE.exec(fileName);
  return match ? match[1] : null;
}

/** Web Crypto rather than `node:crypto`, so the web bundle carries no dead import. */
function defaultRandomHex(): string {
  const bytes = new Uint8Array(2);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

// ------------------------------------------------------------------ store

interface Watcher {
  dir: string;
  onChange: () => void;
  handle: { close(): void } | null;
  timer: ReturnType<typeof setTimeout> | null;
  disposed: boolean;
}

interface SoftDelete {
  key: DocumentKey;
  noteId: string;
  timer: ReturnType<typeof setTimeout>;
  resolve: (outcome: 'trash' | 'permanent' | 'undone' | 'missing') => void;
}

export class NotesStore {
  public readonly root: string;
  private readonly deps: NotesStoreDeps;
  private readonly chains = new Map<string, Promise<unknown>>();
  private readonly recentWrites = new Map<string, number>();
  private readonly watchers = new Set<Watcher>();
  private readonly deleting = new Map<string, SoftDelete>();

  constructor(deps: NotesStoreDeps) {
    this.deps = deps;
    this.root = deps.root;
  }

  // ------------------------------------------------------------- paths

  public folderDir(folderKey: string): string {
    return path.join(this.root, safeSegment(folderKey));
  }

  public documentDir(key: DocumentKey): string {
    return path.join(this.folderDir(key.folder), ...segmentsOf(key.document));
  }

  /** The file of `noteId` in the document's folder, by id prefix, or null. */
  public find(key: DocumentKey, noteId: string): string | null {
    const dir = this.documentDir(key);
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return null;
    }
    for (const name of names) {
      if (noteIdOfFileName(name) === noteId) {
        return path.join(dir, name);
      }
    }
    return null;
  }

  // ------------------------------------------------------------ writing

  /**
   * §7.4 — atomic: the content goes to `.<name>.tmp` beside the target, then
   * is renamed over it. The write is remembered for a second so the watcher
   * does not report it back as an external change.
   */
  private writeAtomic(filePath: string, content: string): void {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, `.${path.basename(filePath)}.tmp`);
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

  /** Run `fn` after every earlier write to the same file has finished (§7.4). */
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

  /**
   * Write a new note. `folderPath` is the workspace folder's absolute path,
   * recorded in a `.folder` marker when the folder key had to be suffixed.
   */
  public async create(
    key: DocumentKey,
    note: ParsedNote,
    folderPath?: string,
  ): Promise<NoteRecord> {
    const dir = this.documentDir(key);
    const filePath = path.join(dir, fileNameFor(note.id, note.passage));
    return this.serialised(filePath, () => {
      this.writeAtomic(filePath, serializeNoteFile(note));
      if (folderPath && /-[0-9a-f]{6}$/.test(key.folder)) {
        const marker = path.join(this.folderDir(key.folder), FOLDER_MARKER);
        if (!fs.existsSync(marker)) {
          try {
            fs.writeFileSync(marker, `${folderPath}\n`, 'utf8');
          } catch {
            /* the marker is a courtesy for a future Relink */
          }
        }
      }
      this.attachPendingWatchers(dir);
      return { ...note, filePath };
    });
  }

  public read(filePath: string): ParsedNote | NoteParseError {
    let text: string;
    try {
      text = fs.readFileSync(filePath, 'utf8');
    } catch (error) {
      return { error: `cannot read: ${String(error)}` };
    }
    return parseNoteFile(text);
  }

  /**
   * §7.4 — rewrite one note: re-read the file first, apply `mutate` to the
   * parsed result, write atomically, all serialised per file. `mutate` may
   * return null to leave the file untouched. A file that became unreadable
   * is left alone and reported as {@link NoteUnreadableError}.
   */
  public async update(
    key: DocumentKey,
    noteId: string,
    mutate: (note: ParsedNote) => ParsedNote | null,
  ): Promise<NoteRecord> {
    const filePath = this.find(key, noteId);
    if (!filePath) {
      throw new NoteMissingError(noteId);
    }
    return this.serialised(filePath, () => {
      const current = this.read(filePath);
      if (isParseError(current)) {
        throw new NoteUnreadableError(filePath, current.error);
      }
      const next = mutate(current);
      if (!next) {
        return { ...current, filePath };
      }
      this.writeAtomic(filePath, serializeNoteFile(next));
      return { ...next, filePath };
    });
  }

  // ------------------------------------------------------------ listing

  /** §7.5 — every readable note of a document, by `created`, plus the unreadable names. */
  public list(key: DocumentKey): NoteListing {
    return this.listDir(this.documentDir(key));
  }

  private listDir(dir: string): NoteListing {
    const notes: NoteRecord[] = [];
    const unreadable: string[] = [];
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return { notes, unreadable };
    }
    for (const name of names) {
      if (!/\.md$/i.test(name) || name.startsWith('.')) {
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
      if (isParseError(parsed)) {
        unreadable.push(filePath);
        continue;
      }
      // A soft-deleted note is listed too: the controller filters it by
      // `deletingIds()`, so Undo can bring it back without a re-read.
      notes.push({ ...parsed, filePath });
    }
    notes.sort((a, b) =>
      a.created < b.created ? -1 : a.created > b.created ? 1 : 0,
    );
    return { notes, unreadable };
  }

  /** The folder keys that exist under the root. */
  public listFolders(): string[] {
    let names: string[];
    try {
      names = fs.readdirSync(this.root);
    } catch {
      return [];
    }
    return names
      .filter((name) => {
        if (name.startsWith('.')) {
          return false;
        }
        try {
          return fs.statSync(path.join(this.root, name)).isDirectory();
        } catch {
          return false;
        }
      })
      .sort();
  }

  /**
   * §7.5 — the documents of one folder: every directory under it that holds
   * note files directly. A directory is a document when it contains a `.md`
   * file (its own name is the document's file name); anything else is a path
   * segment and is walked into.
   */
  public listDocuments(folderKey: string): DocumentListing[] {
    const out: DocumentListing[] = [];
    const base = this.folderDir(folderKey);
    const walk = (dir: string, segments: string[], depth: number) => {
      if (depth > 32) {
        return;
      }
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      let count = 0;
      for (const entry of entries) {
        if (entry.isFile() && noteIdOfFileName(entry.name)) {
          count++;
        }
      }
      if (count > 0) {
        out.push({
          key: { folder: folderKey, document: segments.join('/') },
          dir,
          count,
        });
        return;
      }
      for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith('.')) {
          walk(
            path.join(dir, entry.name),
            [...segments, entry.name],
            depth + 1,
          );
        }
      }
    };
    walk(base, [], 0);
    out.sort((a, b) =>
      a.key.document < b.key.document
        ? -1
        : a.key.document > b.key.document
          ? 1
          : 0,
    );
    return out;
  }

  /**
   * §7.5 — every note under the root, for the quick pick: eager, capped at
   * {@link LIST_ALL_CAP} with a log line beyond it.
   */
  public listAll(): NoteListing & { truncated: boolean } {
    const notes: NoteRecord[] = [];
    const unreadable: string[] = [];
    let truncated = false;
    for (const folder of this.listFolders()) {
      for (const document of this.listDocuments(folder)) {
        const listing = this.listDir(document.dir);
        unreadable.push(...listing.unreadable);
        for (const note of listing.notes) {
          if (notes.length >= LIST_ALL_CAP) {
            truncated = true;
            break;
          }
          notes.push(note);
        }
        if (truncated) {
          break;
        }
      }
      if (truncated) {
        break;
      }
    }
    if (truncated) {
      this.deps.log(
        `notes: listAll stopped at ${LIST_ALL_CAP} notes under ${this.root}`,
      );
    }
    return { notes, unreadable, truncated };
  }

  // ----------------------------------------------------------- watching

  /**
   * §7.6 — watch one document's folder, debounced, own writes ignored. A
   * folder that does not exist yet is watched from the store's first write
   * into it. Best effort: a refused watch logs one line.
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
    if (watcher.disposed || watcher.handle) {
      return;
    }
    if (!fs.existsSync(watcher.dir)) {
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
      this.deps.log(`notes: watch failed ${watcher.dir}: ${String(error)}`);
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
   * §7.7 — soft first: the note is marked for `delayMs`, during which
   * {@link undoDelete} clears the mark with the file never touched. When the
   * window closes the file goes to the trash through the injected callback,
   * or is deleted permanently when the trash refuses.
   */
  public softDelete(
    key: DocumentKey,
    noteId: string,
    delayMs: number,
  ): Promise<'trash' | 'permanent' | 'undone' | 'missing'> {
    const existing = this.deleting.get(noteId);
    if (existing) {
      clearTimeout(existing.timer);
      existing.resolve('undone');
    }
    return new Promise((resolve) => {
      const entry: SoftDelete = {
        key,
        noteId,
        resolve,
        timer: setTimeout(() => {
          void this.finishDelete(entry);
        }, delayMs),
      };
      this.deleting.set(noteId, entry);
    });
  }

  public undoDelete(noteId: string): boolean {
    const entry = this.deleting.get(noteId);
    if (!entry) {
      return false;
    }
    clearTimeout(entry.timer);
    this.deleting.delete(noteId);
    entry.resolve('undone');
    return true;
  }

  public isDeleting(noteId: string): boolean {
    return this.deleting.has(noteId);
  }

  public deletingIds(): string[] {
    return Array.from(this.deleting.keys());
  }

  private async finishDelete(entry: SoftDelete): Promise<void> {
    if (this.deleting.get(entry.noteId) !== entry) {
      return;
    }
    this.deleting.delete(entry.noteId);
    const filePath = this.find(entry.key, entry.noteId);
    if (!filePath) {
      entry.resolve('missing');
      return;
    }
    const outcome = await this.serialised(filePath, async () => {
      this.recentWrites.set(path.basename(filePath), Date.now());
      let trashed: boolean;
      try {
        trashed = await this.deps.trash(filePath);
      } catch (error) {
        this.deps.log(`notes: trash refused ${filePath}: ${String(error)}`);
        trashed = false;
      }
      if (trashed) {
        return 'trash' as const;
      }
      fs.rmSync(filePath, { force: true });
      return 'permanent' as const;
    });
    entry.resolve(outcome);
  }

  /** Delete at once, no window: the trash first, permanent when refused. */
  public async deleteNow(
    key: DocumentKey,
    noteId: string,
  ): Promise<'trash' | 'permanent' | 'missing'> {
    const existing = this.deleting.get(noteId);
    if (existing) {
      clearTimeout(existing.timer);
      this.deleting.delete(noteId);
      existing.resolve('undone');
    }
    const filePath = this.find(key, noteId);
    if (!filePath) {
      return 'missing';
    }
    return this.serialised(filePath, async () => {
      this.recentWrites.set(path.basename(filePath), Date.now());
      let trashed: boolean;
      try {
        trashed = await this.deps.trash(filePath);
      } catch (error) {
        this.deps.log(`notes: trash refused ${filePath}: ${String(error)}`);
        trashed = false;
      }
      if (trashed) {
        return 'trash' as const;
      }
      fs.rmSync(filePath, { force: true });
      return 'permanent' as const;
    });
  }

  // ------------------------------------------------------------- ids

  public newId(): string {
    const now = this.deps.now ? this.deps.now() : new Date();
    const random = this.deps.randomHex
      ? this.deps.randomHex()
      : defaultRandomHex();
    return newNoteId(now, random);
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
      // A pending soft delete is carried out now rather than lost.
      clearTimeout(entry.timer);
      void this.finishDelete(entry);
    }
  }
}
