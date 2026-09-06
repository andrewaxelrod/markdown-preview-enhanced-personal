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
  isModuleParseError,
  parseModuleFile,
  serializeModuleFile,
  type ModuleParseError,
  type ParsedModule,
} from './module-format';

/**
 * The module store (`featrues/13-classroom/spec.md` §11): one `.md` per
 * module under `<root>/modules/<workspace folder key>/<relative path>/`, the
 * persona folders under `<root>/personas/<id>/`, atomic writes, per-file
 * serialisation, a re-read before every rewrite, and, on the notes store's
 * pattern (12 §7.6–§7.7), a debounced watcher that ignores its own writes and
 * a soft delete that ends in the OS trash (§11.4).
 *
 * Node `fs` only, root injected: no `vscode` here, so the whole thing runs
 * against a temp directory in `test/classroom/module-store.test.js`.
 */

export const MODULES_DIR_NAME = 'modules';
export const PERSONAS_DIR_NAME = 'personas';
export const LIST_ALL_CAP = 500;
export const RECENT_WRITE_MS = 1000;
export const WATCH_DEBOUNCE_MS = 300;

export { documentKeyFor, NO_WORKSPACE_FOLDER };
export type { DocumentKey };

export interface ModuleRecord extends ParsedModule {
  filePath: string;
  key: DocumentKey;
}

export interface ModuleListing {
  modules: ModuleRecord[];
  unreadable: string[];
}

export interface PersonaDir {
  id: string;
  dir: string;
  personaFile: string;
  specimenFile: string | null;
}

export type WatchFn = (
  dir: string,
  listener: (eventType: string, fileName: string | Buffer | null) => void,
) => { close(): void };

export interface ModuleStoreDeps {
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
  moduleId: string;
  timer: ReturnType<typeof setTimeout>;
  resolve: (outcome: DeleteOutcome) => void;
}

export type DeleteOutcome = 'trash' | 'permanent' | 'undone' | 'missing';

export class ModuleUnreadableError extends Error {
  public readonly filePath: string;
  constructor(filePath: string, reason: string) {
    super(`The module file could not be updated (${reason})`);
    this.name = 'ModuleUnreadableError';
    this.filePath = filePath;
  }
}

export class ModuleMissingError extends Error {
  constructor(moduleId: string) {
    super(`No module file for ${moduleId}`);
    this.name = 'ModuleMissingError';
  }
}

function defaultRandomHex(): string {
  const bytes = new Uint8Array(2);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export class ModuleStore {
  public readonly root: string;
  private readonly deps: ModuleStoreDeps;
  private readonly chains = new Map<string, Promise<unknown>>();
  private readonly recentWrites = new Map<string, number>();
  private readonly watchers = new Set<Watcher>();
  private readonly deleting = new Map<string, SoftDelete>();

  constructor(deps: ModuleStoreDeps) {
    this.deps = deps;
    this.root = deps.root;
  }

  // ------------------------------------------------------------- paths

  public get modulesRoot(): string {
    return path.join(this.root, MODULES_DIR_NAME);
  }

  public get personasRoot(): string {
    return path.join(this.root, PERSONAS_DIR_NAME);
  }

  public folderDir(folderKey: string): string {
    return path.join(this.modulesRoot, safeSegment(folderKey));
  }

  public documentDir(key: DocumentKey): string {
    return path.join(this.folderDir(key.folder), ...segmentsOf(key.document));
  }

  /** The file of `moduleId` in the document's folder, by id prefix, or null. */
  public find(key: DocumentKey, moduleId: string): string | null {
    const dir = this.documentDir(key);
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return null;
    }
    for (const name of names) {
      if (noteIdOfFileName(name) === moduleId) {
        return path.join(dir, name);
      }
    }
    return null;
  }

  /** §11.2 — whether a path is a module file under this root. */
  public isModulePath(fsPath: string): boolean {
    const relative = path.relative(this.modulesRoot, path.resolve(fsPath));
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      return false;
    }
    const name = path.basename(fsPath);
    return noteIdOfFileName(name) !== null;
  }

  /** The document key a module file's location stands for, or null. */
  public keyOf(fsPath: string): DocumentKey | null {
    if (!this.isModulePath(fsPath)) {
      return null;
    }
    const relative = path.relative(this.modulesRoot, path.resolve(fsPath));
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

  /** Write a new module; the file name is the id plus the passage's slug. */
  public async create(
    key: DocumentKey,
    module: ParsedModule,
  ): Promise<ModuleRecord> {
    const dir = this.documentDir(key);
    const filePath = path.join(
      dir,
      fileNameFor(module.id, module.passage.exact),
    );
    return this.serialised(filePath, () => {
      this.writeAtomic(filePath, serializeModuleFile(module));
      this.attachPendingWatchers(dir);
      return { ...module, filePath, key };
    });
  }

  public read(filePath: string): ParsedModule | ModuleParseError {
    let text: string;
    try {
      text = fs.readFileSync(filePath, 'utf8');
    } catch (error) {
      return { error: `cannot read: ${String(error)}` };
    }
    return parseModuleFile(text);
  }

  /** The record of one module, or null when it is gone or unreadable. */
  public get(key: DocumentKey, moduleId: string): ModuleRecord | null {
    const filePath = this.find(key, moduleId);
    if (!filePath) {
      return null;
    }
    const parsed = this.read(filePath);
    return isModuleParseError(parsed) ? null : { ...parsed, filePath, key };
  }

  /**
   * §11.2 — rewrite one module: re-read, apply `mutate`, write atomically,
   * serialised per file. `mutate` may return null to leave the file alone.
   */
  public async update(
    key: DocumentKey,
    moduleId: string,
    mutate: (module: ParsedModule) => ParsedModule | null,
  ): Promise<ModuleRecord> {
    const filePath = this.find(key, moduleId);
    if (!filePath) {
      throw new ModuleMissingError(moduleId);
    }
    return this.updatePath(filePath, key, mutate);
  }

  public async updatePath(
    filePath: string,
    key: DocumentKey,
    mutate: (module: ParsedModule) => ParsedModule | null,
  ): Promise<ModuleRecord> {
    return this.serialised(filePath, () => {
      const current = this.read(filePath);
      if (isModuleParseError(current)) {
        throw new ModuleUnreadableError(filePath, current.error);
      }
      const next = mutate(current);
      if (!next) {
        return { ...current, filePath, key };
      }
      this.writeAtomic(filePath, serializeModuleFile(next));
      return { ...next, filePath, key };
    });
  }

  // ------------------------------------------------------------ listing

  /** §11.3 — every readable module of a document, newest first. */
  public list(key: DocumentKey): ModuleListing {
    return this.listDir(this.documentDir(key), key);
  }

  private listDir(dir: string, key: DocumentKey): ModuleListing {
    const modules: ModuleRecord[] = [];
    const unreadable: string[] = [];
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return { modules, unreadable };
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
      if (isModuleParseError(parsed)) {
        unreadable.push(filePath);
        continue;
      }
      modules.push({ ...parsed, filePath, key });
    }
    modules.sort((a, b) =>
      a.created < b.created ? 1 : a.created > b.created ? -1 : 0,
    );
    if (unreadable.length) {
      this.deps.log(
        `classroom: ${unreadable.length} unreadable module file(s) under ${dir}`,
      );
    }
    return { modules, unreadable };
  }

  /** §11.3 — every module under `modules/`, for the quick pick, capped. */
  public listAll(): ModuleListing & { truncated: boolean } {
    const modules: ModuleRecord[] = [];
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
      const hasModules = entries.some(
        (entry) => entry.isFile() && noteIdOfFileName(entry.name),
      );
      if (hasModules) {
        const listing = this.listDir(dir, {
          folder: folderKey,
          document: segments.join('/'),
        });
        unreadable.push(...listing.unreadable);
        for (const module of listing.modules) {
          if (modules.length >= LIST_ALL_CAP) {
            truncated = true;
            break;
          }
          modules.push(module);
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
      folders = fs.readdirSync(this.modulesRoot, { withFileTypes: true });
    } catch {
      return { modules, unreadable, truncated };
    }
    for (const folder of folders) {
      if (folder.isDirectory() && !folder.name.startsWith('.')) {
        walk(path.join(this.modulesRoot, folder.name), folder.name, [], 0);
      }
    }
    if (truncated) {
      this.deps.log(
        `classroom: listAll stopped at ${LIST_ALL_CAP} modules under ${this.modulesRoot}`,
      );
    }
    modules.sort((a, b) =>
      a.created < b.created ? 1 : a.created > b.created ? -1 : 0,
    );
    return { modules, unreadable, truncated };
  }

  /** §12.2 — the module a preview's file is, or null for any other file. */
  public moduleAt(fsPath: string): ModuleRecord | null {
    const key = this.keyOf(fsPath);
    if (!key) {
      return null;
    }
    const parsed = this.read(path.resolve(fsPath));
    return isModuleParseError(parsed)
      ? null
      : { ...parsed, filePath: path.resolve(fsPath), key };
  }

  // ----------------------------------------------------------- watching

  /**
   * §11.3 — watch one document's module folder, debounced, own writes
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
      this.deps.log(`classroom: watch failed ${watcher.dir}: ${String(error)}`);
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
   * §11.4 — soft first: the module is marked for `delayMs`, during which
   * {@link undoDelete} clears the mark with the file never touched. When the
   * window closes the file goes to the trash through the injected callback,
   * or is deleted permanently when there is none or it refuses.
   */
  public softDelete(
    key: DocumentKey,
    moduleId: string,
    delayMs: number,
  ): Promise<DeleteOutcome> {
    const existing = this.deleting.get(moduleId);
    if (existing) {
      clearTimeout(existing.timer);
      existing.resolve('undone');
    }
    return new Promise((resolve) => {
      const entry: SoftDelete = {
        key,
        moduleId,
        resolve,
        timer: setTimeout(() => {
          void this.finishDelete(entry);
        }, delayMs),
      };
      this.deleting.set(moduleId, entry);
    });
  }

  public undoDelete(moduleId: string): boolean {
    const entry = this.deleting.get(moduleId);
    if (!entry) {
      return false;
    }
    clearTimeout(entry.timer);
    this.deleting.delete(moduleId);
    entry.resolve('undone');
    return true;
  }

  public isDeleting(moduleId: string): boolean {
    return this.deleting.has(moduleId);
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
        this.deps.log(`classroom: trash refused ${filePath}: ${String(error)}`);
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
    if (this.deleting.get(entry.moduleId) !== entry) {
      return;
    }
    this.deleting.delete(entry.moduleId);
    const filePath = this.find(entry.key, entry.moduleId);
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
    moduleId: string,
  ): Promise<'trash' | 'permanent' | 'missing'> {
    const existing = this.deleting.get(moduleId);
    if (existing) {
      clearTimeout(existing.timer);
      this.deleting.delete(moduleId);
      existing.resolve('undone');
    }
    const filePath = this.find(key, moduleId);
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

  // ----------------------------------------------------------- personas

  /** §7.1 — the user persona folders: `<root>/personas/<id>/persona.md`. */
  public personaDirs(): PersonaDir[] {
    let names: string[];
    try {
      names = fs.readdirSync(this.personasRoot);
    } catch {
      return [];
    }
    const out: PersonaDir[] = [];
    for (const name of names.sort()) {
      if (name.startsWith('.')) {
        continue;
      }
      const dir = path.join(this.personasRoot, name);
      const personaFile = path.join(dir, 'persona.md');
      try {
        if (
          !fs.statSync(dir).isDirectory() ||
          !fs.statSync(personaFile).isFile()
        ) {
          continue;
        }
      } catch {
        continue;
      }
      const specimenFile = path.join(dir, 'specimen.md');
      out.push({
        id: name,
        dir,
        personaFile,
        specimenFile: fs.existsSync(specimenFile) ? specimenFile : null,
      });
    }
    return out;
  }
}
