import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  documentKeyFor,
  type DocumentKey,
  type WorkspaceFolderLike,
} from '../notes/notes-store';
import {
  helpEngineConfig,
  insertPassageMarker,
} from '../read-aloud/controller';
import { GitInfoCache } from '../read-aloud/git-info';
import {
  normaliseHelpAnswer,
  sanitizeHelpAnswer,
} from '../read-aloud/help-answer';
import {
  engineLabel,
  HelpEngineError,
  runHelpEngine,
  type HelpEngineDeps,
  type HelpRunResult,
} from '../read-aloud/help-engine';
import {
  buildCodexPrompt,
  clampField,
  countWords,
  DEFAULT_HELP_AUDIENCE,
  ENCLOSING_OPEN,
  HELP_CAPS,
  trimAroundPassage,
} from '../read-aloud/help-prompt';
import { readAloudLog } from '../read-aloud/log';
import {
  HELP_FIELD_CAPS,
  type ClassroomBuildRequest,
  type ClassroomCancelRequest,
  type ClassroomChapterState,
  type ClassroomModuleConfig,
  type ClassroomModuleRequest,
  type ClassroomOpenSourceRequest,
  type ClassroomPrepareRequest,
  type ClassroomProgress,
  type ClassroomShapeBudgets,
  type HostToWebviewMessage,
  type ReadAloudClassroomModulesMessage,
  type ReadAloudClassroomPreparedMessage,
} from '../read-aloud/messages';
import {
  readClassroomSettings,
  readHelpSettings,
  writeClassroomAudienceSetting,
  writeClassroomPersonaSetting,
} from '../read-aloud/settings';
import { globalConfigPath } from '../utils';
import {
  buildChapterRequest,
  buildRetryRequest,
  type ChapterBrief,
} from './chapter-prompt';
import {
  checkChapter,
  STOP_CODES,
  type CheckBrief,
  type CheckCode,
  type CheckResult,
} from './checks';
import {
  emptyLedger,
  markPaid,
  mergeLedger,
  parseLedger,
  promisesDue,
} from './ledger';
import {
  findLinks,
  resolveLinks,
  sectionRangeFor,
  titleOfSource,
  type FoundLink,
  type LinkResolution,
  type ResolvedLink,
} from './links';
import {
  appendChapter,
  appendClosingLink,
  bridgeOf,
  initialBody,
  previewSummary,
  replaceTitle,
  titleOf,
  type ModuleChapter,
  type ModuleStatus,
  type ParsedModule,
} from './module-format';
import { ModuleStore, type ModuleRecord } from './module-store';
import {
  BUILT_IN_PERSONAS,
  DEFAULT_PERSONA_ID,
  isPersonaParseError,
  mergePersonas,
  parsePersona,
  personaById,
  personaSummary,
  type Persona,
} from './persona';
import {
  budgetFor,
  buildPlanCountRetry,
  buildPlanRequest,
  buildSystemPrompt,
  CLASSROOM_CAPS,
  CLASSROOM_PROMPT_VERSION,
  LEVELS,
  parsePlan,
  passageShapeFor,
  PLAN_SHAPE_ERROR,
  type ChapterBudget,
  type FuelDocument,
  type PassageShape,
} from './plan-prompt';

/**
 * The classroom controller (`featrues/13-classroom/spec.md` §5.3–§5.4, §8,
 * §9, §11–§13): Prepare, Build, the one build queue per host, the build loop
 * with its checks and retry, the append-only writes and the refresh, opening
 * beside, progress, Cancel, Continue, failure, the quick picks and the
 * pending reveal.
 *
 * Node-only, like the store and the engine (§3). The pure pieces — persona,
 * prompts, ledger, checks, codec, store, links — are tested on their own;
 * this class is the `vscode` glue.
 */

export const CLASSROOM_DIR_NAME = 'classroom';
export const CLASSROOM_WEB_BUILD_MESSAGE =
  'Classroom is not available in the web extension.';
export const CLASSROOM_DISABLED_MESSAGE =
  'Classroom is turned off in settings (markdown-preview-enhanced.classroomEnabled).';
export const DIRTY_MODULE_MESSAGE =
  'The module is open with unsaved changes; save it and choose Continue';
export const NO_MODULES_MESSAGE =
  'No classroom modules yet. Select text in a preview and choose Teach me this.';
/** §9.8 — a `writing` module older than this with no build is shown as stopped. */
export const STALE_GRACE_MS = 60000;
/** §9.7 — how long to wait for the TextDocument to follow the disk. */
export const DOCUMENT_FOLLOW_MS = 2000;
/** §11.4 — the Undo window before a deleted module goes to the trash. */
export const UNDO_WINDOW_MS = 6000;

export interface ClassroomControllerDeps {
  isWebBuild: boolean;
  engineDeps: HelpEngineDeps;
  getSinkFor(
    sourceUri: vscode.Uri,
  ): Promise<{ post(message: HostToWebviewMessage): Promise<void> }>;
  getDocumentText(sourceUri: vscode.Uri): Promise<string | undefined>;
  hasPreview(sourceUri: vscode.Uri): boolean;
  /** Open a preview beside (multi-preview) or retarget the single panel. */
  openPreview(sourceUri: vscode.Uri): Promise<void>;
  /** Re-render an open preview from its document (`updateMarkdown`). */
  refreshPreview(sourceUri: vscode.Uri): Promise<void>;
  /** §11.4 — dispose the preview panel(s) of a file (multi-preview mode). */
  closePreview(sourceUri: vscode.Uri): Promise<void>;
  isSinglePreviewMode(): boolean;
  resolveWikilink(
    sourceUri: vscode.Uri,
    target: string,
  ): Promise<vscode.Uri | undefined>;
  markdownExtensions(): string[];
}

interface LinkedFuel {
  /** The workspace-relative path shown on the sheet and written to the file. */
  path: string;
  fsPath: string;
  title: string;
  words: number;
}

interface BuildJob {
  moduleId: string;
  key: DocumentKey;
  filePath: string;
  sourceUri: vscode.Uri;
  moduleUri: vscode.Uri;
  abort: AbortController;
  startedAt: number;
  cwd: string | null;
  opened: boolean;
  persona: Persona;
  audience: string;
  passage: string;
  breadcrumb: string[];
  documentTitle: string;
  enclosing: string;
  level: 1 | 2 | 3;
  /** §6.1 — the passage's shape, decided once per build. */
  shape: PassageShape;
  readerNote: string;
  linked: LinkedFuel[];
  fromContinue: boolean;
}

/** A build that stops for a reason the reader has to act on (§9.7, §9.8). */
class BuildStopped extends Error {
  public readonly status: ModuleStatus;
  constructor(status: 'stopped' | 'failed', message: string) {
    super(message);
    this.name = 'BuildStopped';
    this.status = status;
  }
}

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function fileNameOf(uri: vscode.Uri): string {
  return path.basename(uri.fsPath);
}

function reasonOf(error: unknown): string {
  if (error instanceof HelpEngineError || error instanceof BuildStopped) {
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

function chapterStates(module: ParsedModule): ClassroomChapterState[] {
  return module.chapters.map((chapter) => ({
    n: chapter.n,
    title: chapter.title,
    status: chapter.status,
    flagged: chapter.flagged.slice(),
  }));
}

export class ClassroomController implements vscode.Disposable {
  private readonly deps: ClassroomControllerDeps;
  private store: ModuleStore | null = null;
  private storeRoot = '';
  private readonly queue: BuildJob[] = [];
  private running: BuildJob | null = null;
  private readonly git = new GitInfoCache();
  private readonly lastProgress = new Map<string, ClassroomProgress>();
  private readonly pendingReveal = new Map<
    string,
    { moduleId: string; anchor: ParsedModule['passage'] }
  >();
  private readonly watches = new Map<string, { dispose(): void }>();
  private disposed = false;

  constructor(deps: ClassroomControllerDeps) {
    this.deps = deps;
  }

  // ------------------------------------------------------------ the store

  /** §11.1 — the root: the setting, else `<globalConfigPath>/classroom`. */
  public rootPath(): string {
    const settings = readClassroomSettings();
    return (
      settings.directory || path.join(globalConfigPath, CLASSROOM_DIR_NAME)
    );
  }

  private getStore(): ModuleStore {
    const root = this.rootPath();
    if (this.store && this.storeRoot === root) {
      return this.store;
    }
    this.storeRoot = root;
    for (const watch of this.watches.values()) {
      watch.dispose();
    }
    this.watches.clear();
    this.store?.dispose();
    this.store = new ModuleStore({
      trash: async (filePath) => {
        await vscode.workspace.fs.delete(vscode.Uri.file(filePath), {
          useTrash: true,
          recursive: false,
        });
        return true;
      },
      root,
      log: (line) => readAloudLog(line),
    });
    return this.store;
  }

  public get moduleStore(): ModuleStore {
    return this.getStore();
  }

  // --------------------------------------------------------------- identity

  private folders(): WorkspaceFolderLike[] {
    return (vscode.workspace.workspaceFolders ?? []).map((folder) => ({
      name: folder.name,
      fsPath: folder.uri.fsPath,
    }));
  }

  private identityOf(uri: vscode.Uri): {
    key: DocumentKey;
    folder: WorkspaceFolderLike | null;
    relativePath: string;
  } {
    const workspace = vscode.workspace.getWorkspaceFolder(uri);
    const folder = workspace
      ? { name: workspace.name, fsPath: workspace.uri.fsPath }
      : null;
    const relativePath = workspace
      ? vscode.workspace.asRelativePath(uri, false)
      : '';
    return {
      key: documentKeyFor({
        folder,
        relativePath,
        absolutePath: uri.fsPath,
        folders: this.folders(),
      }),
      folder,
      relativePath,
    };
  }

  // --------------------------------------------------------------- personas

  /** §7.1 — the built-ins with the user packages under `<root>/personas/`. */
  private loadPersonas(): Persona[] {
    const users: Persona[] = [];
    for (const dir of this.getStore().personaDirs()) {
      let text: string;
      let specimen = '';
      try {
        text = fs.readFileSync(dir.personaFile, 'utf8');
        if (dir.specimenFile) {
          specimen = fs.readFileSync(dir.specimenFile, 'utf8');
        }
      } catch (error) {
        readAloudLog(`classroom: persona ${dir.id} skipped: ${String(error)}`);
        continue;
      }
      const parsed = parsePersona(text, specimen, false);
      if (isPersonaParseError(parsed)) {
        readAloudLog(`classroom: persona ${dir.id} skipped: ${parsed.error}`);
        continue;
      }
      if (parsed.id !== dir.id) {
        readAloudLog(
          `classroom: persona ${dir.id} skipped: its id is ${parsed.id}, not the folder's name`,
        );
        continue;
      }
      users.push(parsed);
    }
    return mergePersonas(users, BUILT_IN_PERSONAS);
  }

  private personaInForce(personas: Persona[], wanted: string): Persona {
    const found = personaById(personas, wanted);
    if (found) {
      return found;
    }
    readAloudLog(
      `classroom: persona ${wanted} is not installed; using ${DEFAULT_PERSONA_ID}`,
    );
    return (
      personaById(personas, DEFAULT_PERSONA_ID) ??
      personas[0] ??
      BUILT_IN_PERSONAS[0]
    );
  }

  private audienceFor(persona: Persona, configured: string): string {
    return (
      clampField(configured, CLASSROOM_CAPS.audience) ||
      persona.audience ||
      DEFAULT_HELP_AUDIENCE
    );
  }

  // ---------------------------------------------------------------- posting

  private async post(
    uri: vscode.Uri,
    message: HostToWebviewMessage,
  ): Promise<void> {
    try {
      const sink = await this.deps.getSinkFor(uri);
      await sink.post(message);
    } catch (error) {
      readAloudLog(
        `classroom: post ${message.command} failed: ${String(error)}`,
      );
    }
  }

  private async postError(
    uri: vscode.Uri,
    message: string,
    ids: { requestId?: string; moduleId?: string },
    retryable: boolean = false,
  ): Promise<void> {
    await this.post(uri, {
      command: 'readAloudClassroomError',
      message,
      retryable,
      ...ids,
    });
  }

  private progressOf(
    record: ParsedModule,
    job: BuildJob | null,
    sourceUri: vscode.Uri,
    moduleUri: vscode.Uri,
    overrides: Partial<ClassroomProgress> = {},
  ): ClassroomProgress {
    const writing = record.chapters.find(
      (chapter) => chapter.status === 'writing',
    );
    const done = record.chapters.filter((chapter) => chapter.status === 'done');
    const words = done.reduce((sum, chapter) => sum + (chapter.actual ?? 0), 0);
    const queuePosition = job ? this.queue.indexOf(job) + 1 : 0;
    const status: ModuleStatus =
      job && this.queue.includes(job) ? 'queued' : record.status;
    return {
      moduleId: record.id,
      documentUri: sourceUri.toString(),
      moduleUri: moduleUri.toString(),
      status,
      title: titleOf(record),
      chapter: writing ? writing.n : 0,
      of: record.chapters.length,
      chapterTitle: writing ? writing.title : '',
      chapters: chapterStates(record),
      elapsedMs: job ? Date.now() - job.startedAt : 0,
      words,
      queuePosition,
      error: record.error,
      hasChapter: done.length > 0,
      ...overrides,
    };
  }

  /** §5.4 step 3 — every step posts the whole state to both previews. */
  private async postProgress(
    record: ParsedModule,
    job: BuildJob | null,
    sourceUri: vscode.Uri,
    moduleUri: vscode.Uri,
    overrides: Partial<ClassroomProgress> = {},
  ): Promise<ClassroomProgress> {
    const progress = this.progressOf(
      record,
      job,
      sourceUri,
      moduleUri,
      overrides,
    );
    this.lastProgress.set(record.id, progress);
    const message = {
      command: 'readAloudClassroomProgress' as const,
      ...progress,
    };
    await this.post(sourceUri, message);
    if (this.deps.hasPreview(moduleUri)) {
      await this.post(moduleUri, message);
    }
    return progress;
  }

  // ------------------------------------------------------------ the list

  /** §12.5 — the document's modules, to every panel showing it. */
  public async postModules(uri: vscode.Uri): Promise<void> {
    if (this.deps.isWebBuild || this.disposed) {
      return;
    }
    try {
      const store = this.getStore();
      const { key } = this.identityOf(uri);
      const listing = store.list(key);
      const deleting = store.deletingIds();
      const modules = listing.modules
        .filter((record) => !deleting.includes(record.id))
        .map((record) => previewSummary(this.staleAdjusted(record)));
      const message: ReadAloudClassroomModulesMessage = {
        command: 'readAloudClassroomModules',
        sourceUri: uri.toString(),
        modules,
        deleting: listing.modules
          .filter((record) => deleting.includes(record.id))
          .map((record) => record.id),
        deleteMode: this.deleteMode(),
      };
      await this.post(uri, message);
      readAloudLog(
        `classroom: modules posted ${modules.length} for ${fileNameOf(uri)}`,
      );
    } catch (error) {
      readAloudLog(
        `classroom: modules post failed for ${fileNameOf(uri)}: ${String(error)}`,
      );
    }
  }

  /** §11.4 — whether a delete can end in the OS trash: locally, yes. */
  private deleteMode(): 'trash' | 'permanent' {
    return vscode.env.remoteName ? 'permanent' : 'trash';
  }

  /** §11.3 — watch the document's module folder while a preview shows it. */
  private watchDocument(uri: vscode.Uri): void {
    const id = uri.toString();
    if (this.watches.has(id)) {
      return;
    }
    const store = this.getStore();
    const { key } = this.identityOf(uri);
    this.watches.set(
      id,
      store.watch(key, () => {
        void this.postModules(uri);
      }),
    );
  }

  // ----------------------------------------------------------------- links

  /** §8.2 — the resolver: relative paths against the document, wikilinks through crossnote. */
  private async resolveLink(
    sourceUri: vscode.Uri,
    link: FoundLink,
  ): Promise<LinkResolution | null> {
    let uri: vscode.Uri | undefined;
    if (link.kind === 'wikilink') {
      uri = await this.deps.resolveWikilink(sourceUri, link.target);
    } else {
      uri = vscode.Uri.file(
        path.isAbsolute(link.target)
          ? link.target
          : path.resolve(path.dirname(sourceUri.fsPath), link.target),
      );
    }
    if (!uri || uri.scheme !== 'file') {
      return null;
    }
    return this.acceptLinkedFile(uri);
  }

  /** Exists, is a file, inside a workspace folder, never under the classroom root. */
  private acceptLinkedFile(uri: vscode.Uri): LinkResolution | null {
    try {
      if (!fs.statSync(uri.fsPath).isFile()) {
        return null;
      }
    } catch {
      return null;
    }
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (!folder) {
      return null;
    }
    const root = path.resolve(this.rootPath());
    const relativeToRoot = path.relative(root, uri.fsPath);
    if (
      relativeToRoot &&
      !relativeToRoot.startsWith('..') &&
      !path.isAbsolute(relativeToRoot)
    ) {
      return null;
    }
    return {
      fsPath: uri.fsPath,
      relativePath: vscode.workspace.asRelativePath(uri, false),
    };
  }

  private async readLinked(resolved: ResolvedLink[]): Promise<LinkedFuel[]> {
    const out: LinkedFuel[] = [];
    for (const link of resolved) {
      const uri = vscode.Uri.file(link.fsPath);
      let source: string | undefined;
      try {
        source = await this.deps.getDocumentText(uri);
      } catch {
        source = undefined;
      }
      if (source === undefined) {
        continue;
      }
      out.push({
        path: link.relativePath,
        fsPath: link.fsPath,
        title: titleOfSource(source, path.basename(link.fsPath)),
        words: countWords(source),
      });
    }
    return out;
  }

  private async findLinkedFor(
    sourceUri: vscode.Uri,
    source: string,
    breadcrumb: string[],
  ): Promise<LinkedFuel[]> {
    if (!readClassroomSettings().followLinks) {
      return [];
    }
    const links = findLinks(
      source,
      sectionRangeFor(source, breadcrumb),
      this.deps.markdownExtensions(),
    );
    const resolved = await resolveLinks(
      links,
      (link) => this.resolveLink(sourceUri, link),
      CLASSROOM_CAPS.linkedDocuments,
    );
    return this.readLinked(resolved);
  }

  /** §8.2 — the ticked paths of a Build, re-resolved: never trusted as paths. */
  private async resolveTicked(
    sourceUri: vscode.Uri,
    ticked: string[],
  ): Promise<LinkedFuel[]> {
    const folder = vscode.workspace.getWorkspaceFolder(sourceUri);
    const resolved: ResolvedLink[] = [];
    for (const relative of ticked.slice(0, CLASSROOM_CAPS.linkedDocuments)) {
      const candidates: vscode.Uri[] = [];
      if (folder) {
        candidates.push(vscode.Uri.joinPath(folder.uri, relative));
      }
      for (const other of vscode.workspace.workspaceFolders ?? []) {
        candidates.push(vscode.Uri.joinPath(other.uri, relative));
      }
      for (const candidate of candidates) {
        const accepted = this.acceptLinkedFile(candidate);
        if (accepted) {
          resolved.push({
            target: relative,
            kind: 'path',
            index: 0,
            inSection: false,
            ...accepted,
          });
          break;
        }
      }
    }
    return this.readLinked(resolved);
  }

  // ---------------------------------------------------------------- prepare

  /** §5.3 — what the sheet needs before Build; nothing leaves the machine. */
  public async prepare(request: ClassroomPrepareRequest): Promise<void> {
    const uri = vscode.Uri.parse(request.sourceUri);
    if (this.deps.isWebBuild) {
      await this.postError(uri, CLASSROOM_WEB_BUILD_MESSAGE, {
        requestId: request.requestId,
      });
      return;
    }
    const settings = readClassroomSettings();
    if (!settings.enabled) {
      await this.postError(uri, CLASSROOM_DISABLED_MESSAGE, {
        requestId: request.requestId,
      });
      return;
    }
    try {
      const personas = this.loadPersonas();
      const persona = this.personaInForce(personas, settings.persona);
      let source: string | undefined;
      try {
        source = await this.deps.getDocumentText(uri);
      } catch (error) {
        readAloudLog(`classroom: document read failed: ${String(error)}`);
      }
      const text = source ?? '';
      const linked = await this.findLinkedFor(
        uri,
        text,
        request.fields.breadcrumb,
      );
      const store = this.getStore();
      const { key } = this.identityOf(uri);
      const modules = store
        .list(key)
        .modules.map((record) => previewSummary(this.staleAdjusted(record)));
      const label = engineLabel(helpEngineConfig(readHelpSettings()));
      const job =
        (this.running && this.running.sourceUri.toString() === uri.toString()
          ? this.running
          : null) ??
        this.queue.find(
          (candidate) => candidate.sourceUri.toString() === uri.toString(),
        ) ??
        null;
      const message: ReadAloudClassroomPreparedMessage = {
        command: 'readAloudClassroomPrepared',
        requestId: request.requestId,
        persona: personaSummary(persona),
        personas: personas.map(personaSummary),
        audience: this.audienceFor(persona, settings.audience),
        documentWords: countWords(text),
        linked: linked.map((item) => ({
          path: item.path,
          title: item.title,
          words: item.words,
        })),
        modules,
        engine: {
          engine: label.engine,
          model: label.model,
          effort: label.effort,
        },
        building: job ? (this.lastProgress.get(job.moduleId) ?? null) : null,
        budgets: this.budgetsFor(persona),
        shortTerm: settings.shortTerm,
      };
      await this.post(uri, message);
      readAloudLog(
        `classroom: prepared ${fileNameOf(uri)} (${message.documentWords} words, ${linked.length} linked, ${modules.length} modules)`,
      );
    } catch (error) {
      readAloudLog(`classroom: prepare failed: ${String(error)}`);
      await this.postError(
        uri,
        `Could not prepare the classroom: ${reasonOf(error)}`,
        {
          requestId: request.requestId,
        },
      );
    }
  }

  /** §6.1 — every level's size for both shapes, the persona's overrides applied. */
  private budgetsFor(persona: Persona): ClassroomShapeBudgets {
    const out = {
      passage: {},
      term: {},
    } as ClassroomShapeBudgets;
    for (const shape of ['passage', 'term'] as const) {
      for (const level of [1, 2, 3] as const) {
        const budget = budgetFor(level, shape, persona);
        out[shape][level] = {
          chapters: budget.chapters,
          words: budget.words,
          minutes: budget.minutes,
        };
      }
    }
    return out;
  }

  /** §6.1 — the shape a build takes: a term, unless the setting is off. */
  private shapeFor(passage: string): PassageShape {
    return readClassroomSettings().shortTerm
      ? passageShapeFor(passage)
      : 'passage';
  }

  /** §9.8 — a `writing` module with no build behind it is shown as stopped. */
  private staleAdjusted(record: ModuleRecord): ModuleRecord {
    if (
      record.status !== 'writing' &&
      record.status !== 'planning' &&
      record.status !== 'queued'
    ) {
      return record;
    }
    if (this.jobFor(record.id)) {
      return record;
    }
    const since = new Date(record.updated || record.created).getTime();
    const timeoutMs = readHelpSettings().timeoutSeconds * 1000;
    if (
      Number.isNaN(since) ||
      Date.now() - since > timeoutMs + STALE_GRACE_MS
    ) {
      return {
        ...record,
        status: 'stopped',
        stoppedAt: record.chapters.filter((c) => c.status === 'done').length,
      };
    }
    return record;
  }

  private jobFor(moduleId: string): BuildJob | null {
    if (this.running && this.running.moduleId === moduleId) {
      return this.running;
    }
    return this.queue.find((job) => job.moduleId === moduleId) ?? null;
  }

  // ------------------------------------------------------------------ build

  /** §5.4 step 2 — validate, write the file at once, post, enqueue. */
  public async build(request: ClassroomBuildRequest): Promise<void> {
    const uri = vscode.Uri.parse(request.sourceUri);
    if (this.deps.isWebBuild) {
      await this.postError(uri, CLASSROOM_WEB_BUILD_MESSAGE, {
        requestId: request.requestId,
      });
      return;
    }
    const settings = readClassroomSettings();
    if (!settings.enabled) {
      await this.postError(uri, CLASSROOM_DISABLED_MESSAGE, {
        requestId: request.requestId,
      });
      return;
    }
    const personas = this.loadPersonas();
    const persona = this.personaInForce(personas, request.persona);
    const audience = this.audienceFor(persona, request.audience);
    if (persona.id !== settings.persona) {
      void writeClassroomPersonaSetting(persona.id);
    }
    if (
      request.audience !== settings.audience &&
      request.audience !== persona.audience
    ) {
      void writeClassroomAudienceSetting(request.audience);
    }
    const store = this.getStore();
    const identity = this.identityOf(uri);
    let source = '';
    try {
      source = (await this.deps.getDocumentText(uri)) ?? '';
    } catch (error) {
      readAloudLog(`classroom: document read failed: ${String(error)}`);
    }
    const linked = await this.resolveTicked(uri, request.linked);
    const label = engineLabel(helpEngineConfig(readHelpSettings()));
    const now = nowIso();
    const id = store.newId();
    const passage = clampField(request.passage, CLASSROOM_CAPS.passage);
    const title =
      clampField(request.fields.title, HELP_CAPS.title) || fileNameOf(uri);
    const breadcrumb = request.fields.breadcrumb
      .slice(0, HELP_CAPS.breadcrumbLevels)
      .map((level) => clampField(level, HELP_CAPS.breadcrumbLevel))
      .filter(Boolean);
    const module: ParsedModule = {
      id,
      created: now,
      updated: now,
      finished: null,
      status: 'planning',
      stoppedAt: null,
      error: null,
      persona: { id: persona.id, name: persona.name, version: persona.version },
      level: request.level,
      readerNote: request.readerNote,
      audience,
      engine: {
        engine: label.engine,
        model: label.model,
        effort: label.effort,
        prompt: CLASSROOM_PROMPT_VERSION,
      },
      document: {
        workspace: identity.key.folder,
        path: identity.folder ? identity.key.document : uri.fsPath,
        absolute: uri.fsPath,
        title,
        headings: breadcrumb,
        headingId: request.headingId,
        words: countWords(source),
        git: this.git.knownFor(identity.folder?.fsPath ?? '') ?? {
          remote: '',
          commit: '',
        },
        linked: linked.map((item) => ({
          path: item.path,
          title: item.title,
          words: item.words,
        })),
      },
      passage: { ...request.anchor, exact: passage },
      plan: null,
      chapters: [],
      ledger: emptyLedger(),
      unknown: {},
      body: '',
    };
    module.body = initialBody(module, store.documentDir(identity.key));
    let record: ModuleRecord;
    try {
      record = await store.create(identity.key, module);
    } catch (error) {
      const message = `Could not write the module file: ${reasonOf(error)}`;
      readAloudLog(`classroom: build failed: ${message}`);
      await this.postError(uri, message, { requestId: request.requestId });
      return;
    }
    if (identity.folder) {
      void this.git.get(identity.folder.fsPath);
    }
    const job: BuildJob = {
      moduleId: id,
      key: identity.key,
      filePath: record.filePath,
      sourceUri: uri,
      moduleUri: vscode.Uri.file(record.filePath),
      abort: new AbortController(),
      startedAt: Date.now(),
      cwd: null,
      opened: false,
      persona,
      audience,
      passage,
      breadcrumb,
      documentTitle: title,
      enclosing: trimAroundPassage(
        clampField(request.fields.enclosing, HELP_FIELD_CAPS.enclosing),
        CLASSROOM_CAPS.enclosing,
        ENCLOSING_OPEN,
      ),
      level: request.level,
      shape: this.shapeFor(passage),
      readerNote: request.readerNote,
      linked,
      fromContinue: false,
    };
    readAloudLog(
      `classroom: build ${id} level ${request.level} ${job.shape} ${persona.id} ${label.engine} · ${label.model} · ${label.effort}, fuel ${source.length} chars (${linked.length} linked)`,
    );
    this.watchDocument(uri);
    this.enqueue(job, record);
    await this.postModules(uri);
  }

  private enqueue(job: BuildJob, record: ParsedModule): void {
    this.queue.push(job);
    void this.postProgress(record, job, job.sourceUri, job.moduleUri);
    this.pump();
  }

  private pump(): void {
    if (this.running || this.disposed) {
      return;
    }
    const next = this.queue.shift();
    if (!next) {
      return;
    }
    this.running = next;
    void this.runBuild(next).finally(() => {
      this.running = null;
      this.pump();
    });
  }

  // -------------------------------------------------------- the build loop

  private async readModule(job: BuildJob): Promise<ParsedModule> {
    const record = this.getStore().get(job.key, job.moduleId);
    if (!record) {
      throw new BuildStopped('failed', 'The module file is gone.');
    }
    return record;
  }

  /** §9.7 — a dirty editor buffer is never overwritten. */
  private assertNotDirty(job: BuildJob): void {
    const dirty = vscode.workspace.textDocuments.some(
      (document) => document.uri.fsPath === job.filePath && document.isDirty,
    );
    if (dirty) {
      throw new BuildStopped('stopped', DIRTY_MODULE_MESSAGE);
    }
  }

  private async write(
    job: BuildJob,
    mutate: (module: ParsedModule) => ParsedModule,
  ): Promise<ParsedModule> {
    this.assertNotDirty(job);
    const record = await this.getStore().update(
      job.key,
      job.moduleId,
      (module) => {
        const next = mutate(module);
        next.updated = nowIso();
        return next;
      },
    );
    return record;
  }

  /** §9.7 — after each write: let the TextDocument follow, then re-render. */
  private async refresh(job: BuildJob): Promise<void> {
    if (!this.deps.hasPreview(job.moduleUri)) {
      return;
    }
    const open = vscode.workspace.textDocuments.find(
      (document) => document.uri.fsPath === job.filePath,
    );
    if (open) {
      await new Promise<void>((resolve) => {
        let done = false;
        const finish = () => {
          if (!done) {
            done = true;
            clearTimeout(timer);
            listener.dispose();
            resolve();
          }
        };
        const timer = setTimeout(finish, DOCUMENT_FOLLOW_MS);
        const listener = vscode.workspace.onDidChangeTextDocument((event) => {
          if (event.document.uri.fsPath === job.filePath) {
            finish();
          }
        });
      });
    }
    try {
      await this.deps.refreshPreview(job.moduleUri);
    } catch (error) {
      readAloudLog(`classroom: refresh failed: ${String(error)}`);
    }
  }

  private async buildFuel(job: BuildJob): Promise<string> {
    let source = '';
    try {
      source = (await this.deps.getDocumentText(job.sourceUri)) ?? '';
    } catch (error) {
      readAloudLog(`classroom: document read failed: ${String(error)}`);
    }
    const marked = insertPassageMarker(source, job.passage);
    const capped = trimAroundPassage(marked, CLASSROOM_CAPS.document);
    if (capped.length < marked.length) {
      readAloudLog(
        `classroom: document trimmed to ${CLASSROOM_CAPS.document} of ${marked.length} chars around the passage`,
      );
    }
    const identity = this.identityOf(job.sourceUri);
    const document: FuelDocument = {
      title: job.documentTitle,
      path: identity.folder ? identity.relativePath : fileNameOf(job.sourceUri),
      source: capped,
    };
    const linked: FuelDocument[] = [];
    for (const item of job.linked) {
      let text: string | undefined;
      try {
        text = await this.deps.getDocumentText(vscode.Uri.file(item.fsPath));
      } catch {
        text = undefined;
      }
      if (text === undefined) {
        continue;
      }
      if (text.length > CLASSROOM_CAPS.linkedDocument) {
        readAloudLog(
          `classroom: linked ${item.path} cut to ${CLASSROOM_CAPS.linkedDocument} of ${text.length} chars`,
        );
        text = text.slice(0, CLASSROOM_CAPS.linkedDocument);
      }
      linked.push({ title: item.title, path: item.path, source: text });
    }
    return buildSystemPrompt({
      persona: job.persona,
      audience: job.audience,
      document,
      linked,
    });
  }

  /** §9.1 — one engine call from the build's directory, the cache column logged. */
  private async callEngine(
    job: BuildJob,
    systemPrompt: string,
    userPrompt: string,
    what: string,
  ): Promise<HelpRunResult> {
    const help = readHelpSettings();
    const config = helpEngineConfig(help);
    const run = await runHelpEngine(
      {
        config,
        systemPrompt,
        userPrompt,
        codexPrompt: buildCodexPrompt(systemPrompt, userPrompt),
        signal: job.abort.signal,
        cwd: job.cwd ?? undefined,
      },
      this.deps.engineDeps,
    );
    const cache =
      config.engine === 'claude'
        ? run.cacheRead !== undefined
          ? run.cacheRead > 0
            ? 'hit'
            : 'miss'
          : 'unknown'
        : 'unknown';
    const cost =
      run.costUsd !== undefined ? ` cost $${run.costUsd.toFixed(3)}` : '';
    readAloudLog(
      `classroom: ${what} ${job.moduleId} in ${run.durationMs} (${countWords(run.markdown)} words, cache ${cache}${cost})`,
    );
    return run;
  }

  private async runBuild(job: BuildJob): Promise<void> {
    const started = Date.now();
    try {
      job.cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'mpe-classroom-'));
    } catch (error) {
      job.cwd = null;
      readAloudLog(`classroom: no build directory: ${String(error)}`);
    }
    try {
      let module = await this.readModule(job);
      if (job.fromContinue) {
        readAloudLog(
          `classroom: continue ${job.moduleId} from ${module.chapters.filter((c) => c.status === 'done').length + 1}`,
        );
      }
      module = await this.write(job, (current) => ({
        ...current,
        status: current.plan ? 'writing' : 'planning',
        stoppedAt: null,
        error: null,
        chapters: current.chapters.map((chapter) =>
          chapter.status === 'done'
            ? chapter
            : { ...chapter, status: 'queued' },
        ),
      }));
      await this.postProgress(module, job, job.sourceUri, job.moduleUri);
      const systemPrompt = await this.buildFuel(job);
      readAloudLog(
        `classroom: system prompt ${job.moduleId} ${systemPrompt.length} chars (persona ${job.persona.id} v${job.persona.version}${job.persona.builtIn ? '' : ', user package'})`,
      );
      if (!module.plan) {
        module = await this.plan(job, module, systemPrompt);
      }
      for (const chapter of module.chapters) {
        if (chapter.status === 'done') {
          continue;
        }
        module = await this.writeChapter(job, module, chapter.n, systemPrompt);
      }
      module = await this.write(job, (current) => ({
        ...current,
        body: appendClosingLink(
          current.body,
          current,
          path.dirname(job.filePath),
        ),
        status: 'done',
        finished: nowIso(),
        stoppedAt: null,
        error: null,
      }));
      await this.refresh(job);
      await this.postProgress(module, null, job.sourceUri, job.moduleUri);
      const words = module.chapters.reduce(
        (sum, c) => sum + (c.actual ?? 0),
        0,
      );
      const flagged = module.chapters.filter((c) => c.flagged.length).length;
      readAloudLog(
        `classroom: done ${job.moduleId} in ${Date.now() - started} (${words} words, ${flagged} flagged)`,
      );
    } catch (error) {
      await this.settleFailure(job, error);
    } finally {
      if (job.cwd) {
        try {
          fs.rmSync(job.cwd, { recursive: true, force: true });
        } catch {
          /* under os.tmpdir(); harmless */
        }
        job.cwd = null;
      }
    }
  }

  /** §9.8 — Cancel, a dirty buffer, or a failed call: the file keeps what exists. */
  private async settleFailure(job: BuildJob, error: unknown): Promise<void> {
    const cancelled =
      job.abort.signal.aborted ||
      (error instanceof HelpEngineError && error.code === 'cancelled');
    const stopped =
      cancelled ||
      (error instanceof BuildStopped && error.status === 'stopped');
    const reason = cancelled ? null : reasonOf(error);
    let record: ParsedModule | null;
    try {
      record = await this.getStore().update(job.key, job.moduleId, (module) => {
        const done = module.chapters.filter((c) => c.status === 'done').length;
        return {
          ...module,
          updated: nowIso(),
          status: stopped ? 'stopped' : 'failed',
          stoppedAt: done,
          error: reason,
          chapters: module.chapters.map((chapter) =>
            chapter.status === 'writing'
              ? { ...chapter, status: stopped ? 'queued' : 'failed' }
              : chapter,
          ),
        };
      });
    } catch (writeError) {
      readAloudLog(
        `classroom: could not record the stop of ${job.moduleId}: ${String(writeError)}`,
      );
      record = this.getStore().get(job.key, job.moduleId);
    }
    const done = record
      ? record.chapters.filter((c) => c.status === 'done').length
      : 0;
    if (stopped) {
      readAloudLog(`classroom: stopped ${job.moduleId} after ${done}`);
    } else {
      readAloudLog(
        `classroom: failed ${job.moduleId} at ${done + 1}: ${reason}`,
      );
    }
    if (record) {
      await this.refresh(job);
      await this.postProgress(record, null, job.sourceUri, job.moduleUri, {
        status: stopped ? 'stopped' : 'failed',
        error: reason,
      });
    }
    if (!stopped && reason) {
      await this.postError(
        job.sourceUri,
        reason,
        { moduleId: job.moduleId },
        true,
      );
    }
  }

  /** §9.2 — the plan call, one retry on the count, the rewrite of the front matter. */
  private async plan(
    job: BuildJob,
    module: ParsedModule,
    systemPrompt: string,
  ): Promise<ParsedModule> {
    const chapterBudget = budgetFor(job.level, job.shape, job.persona);
    const budget = chapterBudget.chapters;
    const request = buildPlanRequest({
      passage: job.passage,
      breadcrumb: job.breadcrumb,
      enclosing: job.enclosing,
      level: job.level,
      readerNote: job.readerNote,
      budget,
      shape: chapterBudget.shape,
    });
    const started = Date.now();
    const first = await this.callEngine(job, systemPrompt, request, 'plan');
    let parsed = parsePlan(
      normaliseHelpAnswer(first.markdown),
      job.level,
      budget,
      job.passage,
    );
    if (!parsed.ok) {
      readAloudLog(
        `classroom: plan ${job.moduleId} rejected: ${parsed.reason}`,
      );
      throw new BuildStopped('failed', `${PLAN_SHAPE_ERROR}: ${parsed.reason}`);
    }
    if (!parsed.withinBudget) {
      const got = parsed.plan.chapters.length;
      readAloudLog(
        `classroom: plan ${job.moduleId} had ${got} chapters against ${budget[0]}–${budget[1]}; retrying`,
      );
      const second = await this.callEngine(
        job,
        systemPrompt,
        buildPlanCountRetry(request, got, budget),
        'plan retry',
      );
      const again = parsePlan(
        normaliseHelpAnswer(second.markdown),
        job.level,
        budget,
        job.passage,
      );
      if (again.ok) {
        parsed = again;
      }
    }
    const plan = parsed.plan;
    const chapters: ModuleChapter[] = plan.chapters.map((chapter) => ({
      ...chapter,
      words: chapter.words || chapterBudget.targets[chapter.type],
      status: 'queued',
      actual: null,
      flagged: [],
      ms: null,
    }));
    const git = job.key.folder
      ? (this.git.knownFor(this.folderPathOf(job.key)) ?? null)
      : null;
    const next = await this.write(job, (current) => ({
      ...current,
      status: 'writing',
      plan: { ...plan, chapters: plan.chapters },
      chapters,
      body: replaceTitle(current.body, plan.title),
      document:
        git && !current.document.git.commit
          ? { ...current.document, git: { ...git } }
          : current.document,
    }));
    readAloudLog(
      `classroom: plan ${job.moduleId} in ${Date.now() - started} (${chapters.length} chapters, ${chapterBudget.shape})`,
    );
    await this.refresh(job);
    await this.postProgress(next, job, job.sourceUri, job.moduleUri);
    return next;
  }

  private folderPathOf(key: DocumentKey): string {
    for (const folder of this.folders()) {
      if (
        documentKeyFor({
          folder,
          relativePath: '',
          absolutePath: folder.fsPath,
          folders: this.folders(),
        }).folder === key.folder
      ) {
        return folder.fsPath;
      }
    }
    return '';
  }

  /** §9.3–§9.7 — one chapter: brief, call, checks, one retry, sanitise, append. */
  private async writeChapter(
    job: BuildJob,
    module: ParsedModule,
    n: number,
    systemPrompt: string,
  ): Promise<ParsedModule> {
    const plan = module.plan;
    if (!plan) {
      throw new BuildStopped('failed', 'The module has no plan.');
    }
    const index = module.chapters.findIndex((chapter) => chapter.n === n);
    const chapter = module.chapters[index];
    if (!chapter) {
      throw new BuildStopped('failed', `The plan has no chapter ${n}.`);
    }
    const started = Date.now();
    module = await this.write(job, (current) => ({
      ...current,
      status: 'writing',
      chapters: current.chapters.map((c) =>
        c.n === n ? { ...c, status: 'writing' } : c,
      ),
    }));
    await this.postProgress(module, job, job.sourceUri, job.moduleUri);

    const previousBridge = index === 0 ? null : bridgeOf(module.body) || null;
    const chapterBudget: ChapterBudget = budgetFor(
      job.level,
      job.shape,
      job.persona,
    );
    const target = chapter.words || chapterBudget.targets[chapter.type];
    const ceiling = chapterBudget.ceilings[chapter.type];
    const brief: ChapterBrief = {
      plan,
      chapter,
      level: job.level,
      readerNote: job.readerNote,
      document: { title: job.documentTitle, breadcrumb: job.breadcrumb },
      passage: job.passage,
      previousBridge,
      next: module.chapters[index + 1] ?? null,
      ledger: module.ledger,
      promisesDue: promisesDue(module.ledger, n),
      target,
      ceiling,
    };
    const checkBrief: CheckBrief = {
      title: chapter.title,
      type: chapter.type,
      target,
      ceiling,
      previousBridge,
    };
    const first = await this.callEngine(
      job,
      systemPrompt,
      buildChapterRequest(brief),
      `chapter ${n}/${module.chapters.length}`,
    );
    const draft = normaliseHelpAnswer(first.markdown);
    let check: CheckResult = checkChapter(draft, checkBrief);
    let flagged: CheckCode[] = [];
    if (!check.ok) {
      const codes = check.failures.map((failure) => failure.code);
      readAloudLog(
        `classroom: chapter ${n}/${module.chapters.length} ${job.moduleId} retry: ${codes.join(',')}`,
      );
      const second = await this.callEngine(
        job,
        systemPrompt,
        buildRetryRequest(brief, draft, check.failures, check.words),
        `chapter ${n}/${module.chapters.length} retry`,
      );
      const again = checkChapter(
        normaliseHelpAnswer(second.markdown),
        checkBrief,
      );
      if (again.failures.some((failure) => STOP_CODES.includes(failure.code))) {
        const stop = again.failures.filter((f) => STOP_CODES.includes(f.code));
        await this.getStore().update(job.key, job.moduleId, (current) => ({
          ...current,
          chapters: current.chapters.map((c) =>
            c.n === n
              ? { ...c, status: 'failed', ms: Date.now() - started }
              : c,
          ),
        }));
        throw new BuildStopped(
          'failed',
          `Chapter ${n} did not come back as a chapter (${stop.map((f) => f.code).join(', ')}).`,
        );
      }
      check = again;
      flagged = again.failures.map((failure) => failure.code);
    }
    for (const note of check.notes) {
      readAloudLog(`classroom: chapter ${n} ${job.moduleId} note: ${note}`);
    }
    const body = sanitizeHelpAnswer(check.markdown);
    const parsedLedger = parseLedger(check.ledger);
    if (!parsedLedger.found) {
      readAloudLog(
        `classroom: chapter ${n} ${job.moduleId} came back without a ledger`,
      );
    } else {
      readAloudLog(
        `classroom: chapter ${n} ${job.moduleId} ledger: ${parsedLedger.promises.length} promises, ${parsedLedger.examples.length} examples, ${parsedLedger.terms.length} terms, ${parsedLedger.analogies.length} analogies`,
      );
    }
    const ms = Date.now() - started;
    const next = await this.write(job, (current) => {
      const ledger = markPaid(mergeLedger(current.ledger, parsedLedger, n), n);
      return {
        ...current,
        body: appendChapter(current.body, body),
        ledger,
        chapters: current.chapters.map((c) =>
          c.n === n
            ? {
                ...c,
                status: 'done',
                actual: check.words,
                flagged: flagged.slice(),
                ms,
              }
            : c,
        ),
      };
    });
    readAloudLog(
      `classroom: chapter ${n}/${next.chapters.length} ${job.moduleId} in ${ms} (${check.words} words, ${
        flagged.length ? `flagged: ${flagged.join(',')}` : 'ok'
      })`,
    );
    await this.maybeOpenBeside(job);
    await this.refresh(job);
    await this.postProgress(next, job, job.sourceUri, job.moduleUri);
    return next;
  }

  /** §12.1 — open the module beside the source at the first chapter, once. */
  private async maybeOpenBeside(job: BuildJob): Promise<void> {
    if (job.opened) {
      return;
    }
    job.opened = true;
    if (!readClassroomSettings().autoOpen || this.deps.isSinglePreviewMode()) {
      return;
    }
    if (this.deps.hasPreview(job.moduleUri)) {
      return;
    }
    try {
      await this.deps.openPreview(job.moduleUri);
    } catch (error) {
      readAloudLog(`classroom: open beside failed: ${String(error)}`);
    }
  }

  // ------------------------------------------------- cancel, continue, open

  /** The module named by a request, reached from the document or from itself. */
  private recordFor(uriString: string, moduleId: string): ModuleRecord | null {
    const uri = vscode.Uri.parse(uriString);
    const store = this.getStore();
    const own = store.moduleAt(uri.fsPath);
    if (own && own.id === moduleId) {
      return own;
    }
    const { key } = this.identityOf(uri);
    return store.get(key, moduleId);
  }

  private sourceUriOf(record: ParsedModule): vscode.Uri {
    return vscode.Uri.file(record.document.absolute);
  }

  /** §9.8 — Cancel: abort the running call, or drop the queued build. */
  public async cancel(request: ClassroomCancelRequest): Promise<void> {
    if (this.deps.isWebBuild) {
      return;
    }
    const record = this.recordFor(request.sourceUri, request.moduleId);
    if (!record) {
      return;
    }
    const job = this.jobFor(request.moduleId);
    if (!job) {
      return;
    }
    readAloudLog(
      `classroom: cancel ${request.moduleId} (${request.reason || 'user'})`,
    );
    if (job === this.running) {
      job.abort.abort();
      return;
    }
    const at = this.queue.indexOf(job);
    if (at >= 0) {
      this.queue.splice(at, 1);
    }
    let stopped: ParsedModule | null = null;
    try {
      stopped = await this.getStore().update(
        job.key,
        job.moduleId,
        (module) => ({
          ...module,
          updated: nowIso(),
          status: 'stopped',
          stoppedAt: module.chapters.filter((c) => c.status === 'done').length,
        }),
      );
    } catch (error) {
      readAloudLog(`classroom: could not record the cancel: ${String(error)}`);
    }
    if (stopped) {
      await this.postProgress(stopped, null, job.sourceUri, job.moduleUri);
    }
  }

  /** §9.8 — Continue: re-read the file and resume from the first chapter not done. */
  public async continueModule(request: ClassroomModuleRequest): Promise<void> {
    if (this.deps.isWebBuild) {
      return;
    }
    const record = this.recordFor(request.sourceUri, request.moduleId);
    const uri = vscode.Uri.parse(request.sourceUri);
    if (!record) {
      await this.postError(uri, 'The module file is gone.', {
        moduleId: request.moduleId,
      });
      return;
    }
    await this.continueRecord(record, uri);
  }

  private async continueRecord(
    record: ModuleRecord,
    from: vscode.Uri,
  ): Promise<void> {
    if (this.jobFor(record.id)) {
      return;
    }
    const adjusted = this.staleAdjusted(record);
    if (adjusted.status === 'done') {
      return;
    }
    const personas = this.loadPersonas();
    const persona = this.personaInForce(personas, record.persona.id);
    const sourceUri = this.sourceUriOf(record);
    const linked = await this.resolveTicked(
      sourceUri,
      record.document.linked.map((item) => item.path),
    );
    const job: BuildJob = {
      moduleId: record.id,
      key: record.key,
      filePath: record.filePath,
      sourceUri,
      moduleUri: vscode.Uri.file(record.filePath),
      abort: new AbortController(),
      startedAt: Date.now(),
      cwd: null,
      opened: this.deps.hasPreview(vscode.Uri.file(record.filePath)),
      persona,
      audience: record.audience || this.audienceFor(persona, ''),
      passage: record.passage.exact,
      breadcrumb: record.document.headings.slice(),
      documentTitle: record.document.title || fileNameOf(sourceUri),
      enclosing: '',
      level: record.level,
      shape: this.shapeFor(record.passage.exact),
      readerNote: record.readerNote,
      linked,
      fromContinue: true,
    };
    void from;
    this.enqueue(job, { ...record, status: 'queued' });
  }

  /** §12.1 — Open: the module's preview beside, or the single panel retargeted. */
  public async open(request: ClassroomModuleRequest): Promise<void> {
    if (this.deps.isWebBuild) {
      return;
    }
    const record = this.recordFor(request.sourceUri, request.moduleId);
    if (!record) {
      await this.postError(
        vscode.Uri.parse(request.sourceUri),
        'The module file is gone.',
        {
          moduleId: request.moduleId,
        },
      );
      return;
    }
    await this.openModule(record);
  }

  public async openModule(record: ModuleRecord): Promise<void> {
    try {
      await this.deps.openPreview(vscode.Uri.file(record.filePath));
    } catch (error) {
      readAloudLog(`classroom: open module failed: ${String(error)}`);
    }
  }

  /** §12.4 — _Open the source passage_: the source preview, then the reveal. */
  public async openSource(request: ClassroomOpenSourceRequest): Promise<void> {
    if (this.deps.isWebBuild) {
      return;
    }
    const record = this.recordFor(request.moduleUri, request.moduleId);
    if (!record) {
      return;
    }
    const sourceUri = this.sourceUriOf(record);
    if (this.deps.hasPreview(sourceUri)) {
      await this.post(sourceUri, {
        command: 'readAloudControl',
        action: 'revealAnchor',
        anchor: {
          block: record.passage.block,
          line: record.passage.line,
          exact: record.passage.exact,
          prefix: record.passage.prefix,
          suffix: record.passage.suffix,
          offset: record.passage.offset,
          blocks: record.passage.blocks,
        },
        moduleId: record.id,
      });
      return;
    }
    this.pendingReveal.set(sourceUri.toString(), {
      moduleId: record.id,
      anchor: record.passage,
    });
    try {
      await this.deps.openPreview(sourceUri);
    } catch (error) {
      this.pendingReveal.delete(sourceUri.toString());
      readAloudLog(`classroom: open source failed: ${String(error)}`);
    }
  }

  /** §13 — _Open Classroom Folder_. */
  public async openFolder(): Promise<void> {
    if (this.deps.isWebBuild) {
      void vscode.window.showInformationMessage(CLASSROOM_WEB_BUILD_MESSAGE);
      return;
    }
    const root = vscode.Uri.file(this.getStore().modulesRoot);
    try {
      await vscode.workspace.fs.createDirectory(root);
    } catch {
      /* exists, or cannot be made: revealFileInOS says so */
    }
    await vscode.commands.executeCommand('revealFileInOS', root);
  }

  // ------------------------------------------------------- config, ready

  /** §14.3 — after the config handshake: the pending reveal, the current progress. */
  public onPreviewReady(uri: vscode.Uri): void {
    if (this.deps.isWebBuild || this.disposed) {
      return;
    }
    if (readClassroomSettings().enabled && uri.scheme === 'file') {
      // §12.5 — the document's modules ride behind the handshake, and the
      // folder is watched while the preview is open.
      this.watchDocument(uri);
      void this.postModules(uri);
    }
    const pending = this.pendingReveal.get(uri.toString());
    if (pending) {
      this.pendingReveal.delete(uri.toString());
      void this.post(uri, {
        command: 'readAloudControl',
        action: 'revealAnchor',
        anchor: {
          block: pending.anchor.block,
          line: pending.anchor.line,
          exact: pending.anchor.exact,
          prefix: pending.anchor.prefix,
          suffix: pending.anchor.suffix,
          offset: pending.anchor.offset,
          blocks: pending.anchor.blocks,
        },
        moduleId: pending.moduleId,
      });
    }
    const module = this.getStore().moduleAt(uri.fsPath);
    if (module) {
      const progress = this.lastProgress.get(module.id);
      if (progress && this.jobFor(module.id)) {
        void this.post(uri, {
          command: 'readAloudClassroomProgress',
          ...progress,
        });
      }
    }
  }

  /** §12.2 — what a module preview's `readAloudConfig` carries, or null. */
  public moduleConfigFor(uri: vscode.Uri): ClassroomModuleConfig | null {
    if (this.deps.isWebBuild || uri.scheme !== 'file') {
      return null;
    }
    let record: ModuleRecord | null;
    try {
      record = this.getStore().moduleAt(uri.fsPath);
    } catch {
      record = null;
    }
    if (!record) {
      return null;
    }
    const adjusted = this.staleAdjusted(record);
    return {
      id: adjusted.id,
      title: titleOf(adjusted),
      status: adjusted.status,
      chapters: chapterStates(adjusted),
      documentTitle: adjusted.document.title,
      documentPath: adjusted.document.path,
      documentHeading: adjusted.document.headings.length
        ? adjusted.document.headings[adjusted.document.headings.length - 1]
        : '',
    };
  }

  // ---------------------------------------------------------------- delete

  /**
   * §11.4 — soft first: a build in the way is cancelled, the module is marked,
   * the list is re-posted without it, and six seconds later the file goes to
   * the trash. `fromCommand` shows the information message with Undo when no
   * preview shows the document; the previews' chip does it otherwise.
   */
  public async delete(
    request: ClassroomModuleRequest,
    fromCommand: boolean = false,
  ): Promise<void> {
    if (this.deps.isWebBuild) {
      return;
    }
    const record = this.recordFor(request.sourceUri, request.moduleId);
    if (!record) {
      await this.postError(
        vscode.Uri.parse(request.sourceUri),
        'The module file is gone.',
        { moduleId: request.moduleId },
      );
      return;
    }
    const sourceUri = this.sourceUriOf(record);
    const moduleUri = vscode.Uri.file(record.filePath);
    const job = this.jobFor(record.id);
    if (job) {
      await this.cancel({
        sourceUri: sourceUri.toString(),
        moduleId: record.id,
        reason: 'delete',
      });
    }
    const store = this.getStore();
    const done = store.softDelete(record.key, record.id, UNDO_WINDOW_MS);
    readAloudLog(`classroom: deleting ${record.id}`);
    await this.postModules(sourceUri);
    if (this.deps.hasPreview(moduleUri)) {
      await this.post(moduleUri, {
        command: 'readAloudClassroomModules',
        sourceUri: moduleUri.toString(),
        modules: [],
        deleting: [record.id],
        deleteMode: this.deleteMode(),
      });
    }
    if (fromCommand && !this.deps.hasPreview(sourceUri)) {
      const label =
        this.deleteMode() === 'trash'
          ? 'Module moved to Trash'
          : 'Module deleted';
      void vscode.window
        .showInformationMessage(label, 'Undo')
        .then((choice) => {
          if (choice === 'Undo') {
            void this.undoDelete({
              sourceUri: sourceUri.toString(),
              moduleId: record.id,
            });
          }
        });
    }
    const outcome = await done;
    if (outcome === 'trash' || outcome === 'permanent') {
      readAloudLog(`classroom: deleted ${record.id} (${outcome})`);
      this.lastProgress.delete(record.id);
      if (this.deps.hasPreview(moduleUri)) {
        // The module's own preview has nothing left to show (§11.4).
        try {
          if (this.deps.isSinglePreviewMode()) {
            await this.deps.openPreview(sourceUri);
          } else {
            await this.deps.closePreview(moduleUri);
          }
        } catch (error) {
          readAloudLog(
            `classroom: close module preview failed: ${String(error)}`,
          );
        }
      }
    }
    await this.postModules(sourceUri);
  }

  public async undoDelete(request: ClassroomModuleRequest): Promise<void> {
    if (this.deps.isWebBuild) {
      return;
    }
    const record = this.recordFor(request.sourceUri, request.moduleId);
    const store = this.getStore();
    if (store.undoDelete(request.moduleId)) {
      readAloudLog(`classroom: undo delete ${request.moduleId}`);
    }
    const sourceUri = record
      ? this.sourceUriOf(record)
      : vscode.Uri.parse(request.sourceUri);
    await this.postModules(sourceUri);
    if (record) {
      const moduleUri = vscode.Uri.file(record.filePath);
      if (this.deps.hasPreview(moduleUri)) {
        await this.post(moduleUri, {
          command: 'readAloudClassroomModules',
          sourceUri: moduleUri.toString(),
          modules: [],
          deleting: [],
          deleteMode: this.deleteMode(),
        });
      }
    }
  }

  /** §13 — _Delete Classroom Module_: the active module preview's, else a quick pick. */
  public async deleteCommand(activeModuleUri?: vscode.Uri): Promise<void> {
    if (this.deps.isWebBuild) {
      void vscode.window.showInformationMessage(CLASSROOM_WEB_BUILD_MESSAGE);
      return;
    }
    const store = this.getStore();
    if (activeModuleUri) {
      const active = store.moduleAt(activeModuleUri.fsPath);
      if (active) {
        await this.delete(
          { sourceUri: activeModuleUri.toString(), moduleId: active.id },
          true,
        );
        return;
      }
    }
    const all = store.listAll();
    if (!all.modules.length) {
      void vscode.window.showInformationMessage(NO_MODULES_MESSAGE);
      return;
    }
    const picked = await vscode.window.showQuickPick(
      this.pickItems(all.modules),
      {
        placeHolder: 'Delete which classroom module?',
        matchOnDescription: true,
        matchOnDetail: true,
      },
    );
    if (picked) {
      await this.delete(
        {
          sourceUri: vscode.Uri.file(picked.record.filePath).toString(),
          moduleId: picked.record.id,
        },
        true,
      );
    }
  }

  // ------------------------------------------------------ palette commands

  private shortDate(iso: string): string {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) {
      return '';
    }
    try {
      return date.toLocaleDateString(undefined, {
        day: 'numeric',
        month: 'short',
      });
    } catch {
      return iso.slice(0, 10);
    }
  }

  private pickItems(records: ModuleRecord[]) {
    return records.map((record) => {
      const summary = previewSummary(this.staleAdjusted(record));
      return {
        label: summary.title,
        description: `${record.document.workspace}/${record.document.path} · ${this.shortDate(
          record.created,
        )} · ${summary.chapters} chapters · ${summary.status}`,
        detail: record.passage.exact.replace(/\s+/g, ' ').slice(0, 100),
        record,
      };
    });
  }

  /** §13 — _Open Classroom Module_: every module across documents. */
  public async openQuickPick(): Promise<void> {
    if (this.deps.isWebBuild) {
      void vscode.window.showInformationMessage(CLASSROOM_WEB_BUILD_MESSAGE);
      return;
    }
    const all = this.getStore().listAll();
    if (!all.modules.length) {
      void vscode.window.showInformationMessage(NO_MODULES_MESSAGE);
      return;
    }
    const picked = await vscode.window.showQuickPick(
      this.pickItems(all.modules),
      {
        placeHolder: 'Open a classroom module',
        matchOnDescription: true,
        matchOnDetail: true,
      },
    );
    if (picked) {
      await this.openModule(picked.record);
    }
  }

  /** §13 — _Continue Classroom Module_. */
  public async continueCommand(activeModuleUri?: vscode.Uri): Promise<void> {
    if (this.deps.isWebBuild) {
      void vscode.window.showInformationMessage(CLASSROOM_WEB_BUILD_MESSAGE);
      return;
    }
    const store = this.getStore();
    if (activeModuleUri) {
      const active = store.moduleAt(activeModuleUri.fsPath);
      if (active) {
        const adjusted = this.staleAdjusted(active);
        if (adjusted.status === 'stopped' || adjusted.status === 'failed') {
          await this.continueRecord(active, activeModuleUri);
          return;
        }
      }
    }
    const candidates = store
      .listAll()
      .modules.map((record) => this.staleAdjusted(record))
      .filter(
        (record) => record.status === 'stopped' || record.status === 'failed',
      );
    if (!candidates.length) {
      void vscode.window.showInformationMessage(
        'No stopped or failed classroom module to continue.',
      );
      return;
    }
    const picked = await vscode.window.showQuickPick(
      this.pickItems(candidates),
      {
        placeHolder: 'Continue a classroom module',
        matchOnDescription: true,
        matchOnDetail: true,
      },
    );
    if (picked) {
      await this.continueRecord(
        picked.record,
        vscode.Uri.file(picked.record.filePath),
      );
    }
  }

  /** §13 — _Cancel Classroom Build_. */
  public async cancelCommand(): Promise<void> {
    if (this.deps.isWebBuild) {
      void vscode.window.showInformationMessage(CLASSROOM_WEB_BUILD_MESSAGE);
      return;
    }
    const jobs = [...(this.running ? [this.running] : []), ...this.queue];
    if (!jobs.length) {
      void vscode.window.showInformationMessage(
        'No classroom build is running.',
      );
      return;
    }
    let target: BuildJob | undefined = jobs[0];
    if (jobs.length > 1) {
      const picked = await vscode.window.showQuickPick(
        jobs.map((job) => ({
          label: this.lastProgress.get(job.moduleId)?.title ?? job.moduleId,
          description: job === this.running ? 'writing' : 'waiting',
          job,
        })),
        { placeHolder: 'Cancel which build?' },
      );
      target = picked?.job;
    }
    if (target) {
      await this.cancel({
        sourceUri: target.sourceUri.toString(),
        moduleId: target.moduleId,
        reason: 'palette',
      });
    }
  }

  // ---------------------------------------------------------------- dispose

  public dispose(): void {
    this.disposed = true;
    const running = this.running;
    this.queue.length = 0;
    if (running) {
      running.abort.abort();
      this.running = null;
    }
    for (const watch of this.watches.values()) {
      watch.dispose();
    }
    this.watches.clear();
    this.store?.dispose();
    this.store = null;
  }
}

/** For the tests and the tree of future revisions: the levels the sheet shows. */
export const CLASSROOM_LEVEL_ROWS = [1, 2, 3].map(
  (level) => LEVELS[level as 1 | 2 | 3].row,
);
