import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { titleOfSource } from '../classroom/links';
import {
  documentKeyFor,
  type DocumentKey,
  type WorkspaceFolderLike,
} from '../notes/notes-store';
import { helpEngineConfig } from '../read-aloud/controller';
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
  HELP_CAPS,
} from '../read-aloud/help-prompt';
import { readAloudLog } from '../read-aloud/log';
import {
  type EditionSummary,
  type HostToWebviewMessage,
  type NoteAnchorPayload,
  type ReadAloudRetellEditionsMessage,
  type ReadAloudRetellPreparedMessage,
  type RetellBuildRequest,
  type RetellCancelRequest,
  type RetellEditionConfig,
  type RetellEditionRequest,
  type RetellOpenSourceRequest,
  type RetellPrepareRequest,
  type RetellProgress,
  type RetellScope,
  type RetellStatus,
  type RetellUnit,
} from '../read-aloud/messages';
import { readHelpSettings, readRetellSettings } from '../read-aloud/settings';
import { globalConfigPath } from '../utils';
import {
  checkEdition,
  normaliseHeadings,
  retellRuleText,
  type EditionCheckBrief,
  type EditionCheckResult,
  type RetellCheckCode,
} from './checks';
import {
  appendSection,
  placeSection,
  backLinkFor,
  frameFor,
  initialBody,
  previewSummary,
  splitBody,
  titleOf,
  unitStates,
  writtenLevelOffset,
  type EditionAnchor,
  type EditionSection,
  type ParsedEdition,
} from './edition-format';
import { EditionStore, type EditionRecord } from './edition-store';
import { ceilingFor, estimateFor, underFor } from './estimate';
import {
  buildFirstRequest,
  buildRetryRequest,
  buildSystemPrompt,
  cutSection,
  DEFAULT_RETELL_SHAPE,
  outlineText,
  RETELL_CAPS,
  RETELL_PROMPT_VERSION,
  sectionHash,
  type RetellMaterial,
} from './retell-prompt';
import {
  allUnits,
  breadcrumbFor,
  coverCheck,
  headingsIn,
  normaliseHeadingText,
  outlineOf,
  sameHeading,
  sectionStats,
  sectionText,
  unitsFor,
  type OutlineHeading,
  type SectionUnit,
} from './sections';

/**
 * The retell controller (`featrues/15-convert-readable/spec.md` §5.3–§5.4,
 * §6, §9, §11–§13): Prepare, Build, Rebuild, the one build queue per host,
 * the build loop with its checks and retry, the append-only writes and the
 * refresh, opening beside, progress, Cancel, Continue, failure, the quick
 * picks, the whole-document command and the pending reveal.
 *
 * Node-only, like the store and the engine (§3). The pure pieces — the
 * resolver, the estimate, the prompts, the checks, the codec, the store — are
 * tested on their own; this class is the `vscode` glue, on the classroom
 * controller's pattern.
 */

export const RETELL_DIR_NAME = 'retell';
export const RETELL_WEB_BUILD_MESSAGE =
  'Retell is not available in the web extension.';
export const RETELL_DISABLED_MESSAGE =
  'Retell is turned off in settings (markdown-preview-enhanced.retellEnabled).';
export const DIRTY_EDITION_MESSAGE =
  'The edition is open with unsaved changes; save it and choose Continue';
export const NO_EDITIONS_MESSAGE =
  'No spoken editions yet. Select a section in a preview and choose Retell.';
export const NO_SECTIONS_MESSAGE = 'This document has no sections to retell';
export const OUT_OF_STEP_MESSAGE =
  'The preview and the file are out of step; save the document and try again';
export const EDITION_GONE_MESSAGE = 'The edition file is gone.';
/** §9.6 — a `writing` edition older than this with no build is shown as stopped. */
export const STALE_GRACE_MS = 60000;
/** §9.5 — how long to wait for the TextDocument to follow the disk. */
export const DOCUMENT_FOLLOW_MS = 2000;
/** §11.3 — the Undo window before a deleted edition goes to the trash. */
export const UNDO_WINDOW_MS = 6000;

export interface RetellControllerDeps {
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
  /** §11.3 — dispose the preview panel(s) of a file (multi-preview mode). */
  closePreview(sourceUri: vscode.Uri): Promise<void>;
  isSinglePreviewMode(): boolean;
  /** Post a `readAloudControl` to every preview (the document command). */
  postToAll(message: HostToWebviewMessage): Promise<void>;
}

interface BuildJob {
  editionId: string;
  key: DocumentKey;
  filePath: string;
  sourceUri: vscode.Uri;
  editionUri: vscode.Uri;
  abort: AbortController;
  startedAt: number;
  cwd: string | null;
  opened: boolean;
  fileName: string;
  scope: RetellScope;
  /** §9.8 — the units a Rebuild copied forward, by `n`. */
  cached: Set<number>;
  fromContinue: boolean;
  /** The document command's notification, when it built without a sheet. */
  onProgress: ((progress: RetellProgress) => void) | null;
  onEnd: (() => void) | null;
}

/** A build that stops for a reason the reader has to act on (§9.5, §9.6). */
class BuildStopped extends Error {
  public readonly status: RetellStatus;
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

/** §12.5 — the anchor of a unit's heading, found by its text (an empty block key). */
function anchorForUnit(unit: SectionUnit): EditionAnchor {
  return {
    exact: normaliseHeadingText(unit.heading),
    block: '',
    line: unit.line,
    prefix: '',
    suffix: '',
    offset: 0,
    blocks: 1,
  };
}

function anchorPayload(anchor: EditionAnchor): NoteAnchorPayload {
  return {
    block: anchor.block,
    line: anchor.line,
    exact: anchor.exact,
    prefix: anchor.prefix,
    suffix: anchor.suffix,
    offset: anchor.offset,
    blocks: anchor.blocks,
  };
}

export class RetellController implements vscode.Disposable {
  private readonly deps: RetellControllerDeps;
  private store: EditionStore | null = null;
  private storeRoot = '';
  private readonly queue: BuildJob[] = [];
  private running: BuildJob | null = null;
  private readonly git = new GitInfoCache();
  private readonly lastProgress = new Map<string, RetellProgress>();
  private readonly pendingReveal = new Map<
    string,
    { editionId: string; anchor: EditionAnchor }
  >();
  private readonly watches = new Map<string, { dispose(): void }>();
  private disposed = false;

  constructor(deps: RetellControllerDeps) {
    this.deps = deps;
  }

  // ------------------------------------------------------------ the store

  /** §11.1 — the root: the setting, else `<globalConfigPath>/retell`. */
  public rootPath(): string {
    const settings = readRetellSettings();
    return settings.directory || path.join(globalConfigPath, RETELL_DIR_NAME);
  }

  private getStore(): EditionStore {
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
    this.store = new EditionStore({
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

  public get editionStore(): EditionStore {
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

  // ---------------------------------------------------------------- posting

  private async post(
    uri: vscode.Uri,
    message: HostToWebviewMessage,
  ): Promise<void> {
    try {
      const sink = await this.deps.getSinkFor(uri);
      await sink.post(message);
    } catch (error) {
      readAloudLog(`retell: post ${message.command} failed: ${String(error)}`);
    }
  }

  private async postError(
    uri: vscode.Uri,
    message: string,
    ids: { requestId?: string; editionId?: string },
    retryable: boolean = false,
  ): Promise<void> {
    await this.post(uri, {
      command: 'readAloudRetellError',
      message,
      retryable,
      ...ids,
    });
  }

  private progressOf(
    edition: ParsedEdition,
    job: BuildJob | null,
    sourceUri: vscode.Uri,
    editionUri: vscode.Uri,
    overrides: Partial<RetellProgress> = {},
  ): RetellProgress {
    const writing = edition.sections.find(
      (section) => section.status === 'writing',
    );
    const done = edition.sections.filter(
      (section) => section.status === 'done',
    );
    const words = done.reduce((sum, section) => sum + (section.actual ?? 0), 0);
    const queuePosition = job ? this.queue.indexOf(job) + 1 : 0;
    const status: RetellStatus =
      job && this.queue.includes(job) ? 'queued' : edition.status;
    return {
      editionId: edition.id,
      documentUri: sourceUri.toString(),
      editionUri: editionUri.toString(),
      status,
      title: titleOf(edition),
      section: writing ? writing.n : 0,
      of: edition.sections.length,
      sectionHeading: writing ? writing.heading : '',
      sections: unitStates(edition, job ? job.cached : undefined),
      elapsedMs: job ? Date.now() - job.startedAt : 0,
      words,
      queuePosition,
      hasSection: done.length > 0,
      error: edition.error,
      ...overrides,
    };
  }

  /** §5.4 step 3 — every step posts the whole state to both previews. */
  private async postProgress(
    edition: ParsedEdition,
    job: BuildJob | null,
    sourceUri: vscode.Uri,
    editionUri: vscode.Uri,
    overrides: Partial<RetellProgress> = {},
  ): Promise<RetellProgress> {
    const progress = this.progressOf(
      edition,
      job,
      sourceUri,
      editionUri,
      overrides,
    );
    this.lastProgress.set(edition.id, progress);
    const message = {
      command: 'readAloudRetellProgress' as const,
      ...progress,
    };
    await this.post(sourceUri, message);
    if (this.deps.hasPreview(editionUri)) {
      await this.post(editionUri, message);
    }
    if (job && job.onProgress) {
      try {
        job.onProgress(progress);
      } catch {
        /* the notification is a courtesy */
      }
    }
    return progress;
  }

  // ------------------------------------------------------------ the list

  /** §12.5 — the document's editions, to every panel showing it. */
  public async postEditions(uri: vscode.Uri): Promise<void> {
    if (this.deps.isWebBuild || this.disposed) {
      return;
    }
    try {
      const store = this.getStore();
      const { key } = this.identityOf(uri);
      const listing = store.list(key);
      const deleting = store.deletingIds();
      const editions = listing.editions
        .filter((record) => !deleting.includes(record.id))
        .map((record) => this.summaryOf(this.staleAdjusted(record)));
      const message: ReadAloudRetellEditionsMessage = {
        command: 'readAloudRetellEditions',
        sourceUri: uri.toString(),
        editions,
        deleting: listing.editions
          .filter((record) => deleting.includes(record.id))
          .map((record) => record.id),
        deleteMode: this.deleteMode(),
      };
      await this.post(uri, message);
      readAloudLog(
        `retell: editions posted ${editions.length} for ${fileNameOf(uri)}`,
      );
    } catch (error) {
      readAloudLog(
        `retell: editions post failed for ${fileNameOf(uri)}: ${String(error)}`,
      );
    }
  }

  private summaryOf(record: ParsedEdition): EditionSummary {
    return previewSummary(record);
  }

  /** §11.3 — whether a delete can end in the OS trash: locally, yes. */
  private deleteMode(): 'trash' | 'permanent' {
    return vscode.env.remoteName ? 'permanent' : 'trash';
  }

  /** §11.2 — watch the document's edition folder while a preview shows it. */
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
        void this.postEditions(uri);
      }),
    );
  }

  // ------------------------------------------------------------- resolving

  private async readSource(uri: vscode.Uri): Promise<string> {
    try {
      return (await this.deps.getDocumentText(uri)) ?? '';
    } catch (error) {
      readAloudLog(`retell: document read failed: ${String(error)}`);
      return '';
    }
  }

  /** §6.2 — the units a request covers, in document order. */
  private unitsOf(
    source: string,
    fileName: string,
    scope: RetellScope,
    cover: { startLine: number; endLine: number },
  ): { units: SectionUnit[]; widened: boolean } | null {
    if (scope === 'document') {
      const units = allUnits(source, { fileName });
      return units.length ? { units, widened: false } : null;
    }
    const result = unitsFor(source, cover, { fileName });
    if (!result.ok || !result.units.length) {
      return null;
    }
    return { units: result.units, widened: result.widened };
  }

  private unitPayload(source: string, unit: SectionUnit): RetellUnit {
    const stats = sectionStats(source, unit);
    return {
      n: unit.n,
      heading: unit.heading,
      level: unit.level,
      line: unit.line,
      endLine: unit.endLine,
      words: stats.words,
      codeWords: stats.codeWords,
      tableWords: stats.tableWords,
      proseWords: stats.proseWords,
      fences: stats.fences,
      tables: stats.tables,
    };
  }

  /** §5.2 — the edition a Rebuild would reuse: one that covers every unit, newest first. */
  private rebuildCandidate(
    records: ParsedEdition[],
    units: SectionUnit[],
    scope: RetellScope,
  ): string | null {
    for (const record of records) {
      if (record.scope !== scope || record.sections.length !== units.length) {
        continue;
      }
      if (
        record.status !== 'done' &&
        record.status !== 'stopped' &&
        record.status !== 'failed'
      ) {
        continue;
      }
      const same = record.sections.every((section, i) =>
        sameHeading(section.heading, units[i].heading),
      );
      if (same) {
        return record.id;
      }
    }
    return null;
  }

  // ---------------------------------------------------------------- prepare

  /** §5.3 — what the sheet needs before Build; nothing leaves the machine. */
  public async prepare(request: RetellPrepareRequest): Promise<void> {
    const uri = vscode.Uri.parse(request.sourceUri);
    if (this.deps.isWebBuild) {
      await this.postError(uri, RETELL_WEB_BUILD_MESSAGE, {
        requestId: request.requestId,
      });
      return;
    }
    if (!readRetellSettings().enabled) {
      await this.postError(uri, RETELL_DISABLED_MESSAGE, {
        requestId: request.requestId,
      });
      return;
    }
    try {
      const source = await this.readSource(uri);
      const fileName = fileNameOf(uri);
      const resolved = this.unitsOf(source, fileName, request.scope, {
        startLine: request.startLine,
        endLine: request.endLine,
      });
      if (!resolved) {
        await this.postError(uri, NO_SECTIONS_MESSAGE, {
          requestId: request.requestId,
        });
        return;
      }
      const units = resolved.units.map((unit) =>
        this.unitPayload(source, unit),
      );
      const sourceWords = units.reduce((sum, unit) => sum + unit.words, 0);
      const estimate = estimateFor(sourceWords);
      const store = this.getStore();
      const { key } = this.identityOf(uri);
      const records = store
        .list(key)
        .editions.map((record) => this.staleAdjusted(record));
      const label = engineLabel(helpEngineConfig(readHelpSettings()));
      const job =
        (this.running && this.running.sourceUri.toString() === uri.toString()
          ? this.running
          : null) ??
        this.queue.find(
          (candidate) => candidate.sourceUri.toString() === uri.toString(),
        ) ??
        null;
      const message: ReadAloudRetellPreparedMessage = {
        command: 'readAloudRetellPrepared',
        requestId: request.requestId,
        units,
        sourceWords,
        estimate: { words: estimate.words, minutes: estimate.minutes },
        ceiling: ceilingFor(sourceWords),
        widened: resolved.widened,
        shape: DEFAULT_RETELL_SHAPE,
        engine: {
          engine: label.engine,
          model: label.model,
          effort: label.effort,
        },
        editions: records.map((record) => this.summaryOf(record)),
        rebuildOf: this.rebuildCandidate(
          records,
          resolved.units,
          request.scope,
        ),
        building: job ? (this.lastProgress.get(job.editionId) ?? null) : null,
      };
      await this.post(uri, message);
      readAloudLog(
        `retell: prepared ${fileName} (${units.length} sections, ${sourceWords} words, ${records.length} editions)`,
      );
    } catch (error) {
      readAloudLog(`retell: prepare failed: ${String(error)}`);
      await this.postError(
        uri,
        `Could not prepare the retell: ${reasonOf(error)}`,
        { requestId: request.requestId },
      );
    }
  }

  /** §9.6 — a `writing` edition with no build behind it is shown as stopped. */
  private staleAdjusted(record: EditionRecord): EditionRecord {
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
        stoppedAt: record.sections.filter((s) => s.status === 'done').length,
      };
    }
    return record;
  }

  private jobFor(editionId: string): BuildJob | null {
    if (this.running && this.running.editionId === editionId) {
      return this.running;
    }
    return this.queue.find((job) => job.editionId === editionId) ?? null;
  }

  // ------------------------------------------------------------------ build

  /** §5.4 step 2 — validate, write the file at once, post, enqueue. */
  public async build(
    request: RetellBuildRequest,
    hooks: {
      onProgress?: (progress: RetellProgress) => void;
      onEnd?: () => void;
    } = {},
  ): Promise<string | null> {
    const uri = vscode.Uri.parse(request.sourceUri);
    if (this.deps.isWebBuild) {
      await this.postError(uri, RETELL_WEB_BUILD_MESSAGE, {
        requestId: request.requestId,
      });
      return null;
    }
    if (!readRetellSettings().enabled) {
      await this.postError(uri, RETELL_DISABLED_MESSAGE, {
        requestId: request.requestId,
      });
      return null;
    }
    const source = await this.readSource(uri);
    const fileName = fileNameOf(uri);
    let cover = { startLine: request.startLine, endLine: request.endLine };
    if (request.scope === 'selection' && request.anchor) {
      // §6.3 — the preview may be a render behind the file.
      const check = coverCheck(source, request.startLine, request.anchor.exact);
      if (!check.ok) {
        await this.postError(uri, OUT_OF_STEP_MESSAGE, {
          requestId: request.requestId,
        });
        return null;
      }
      if (check.moved) {
        readAloudLog(
          `retell: cover moved ${request.startLine} → ${check.startLine}`,
        );
        const delta = check.startLine - request.startLine;
        cover = {
          startLine: check.startLine,
          endLine: Math.max(check.startLine, request.endLine + delta),
        };
      }
    }
    const resolved = this.unitsOf(source, fileName, request.scope, cover);
    if (!resolved) {
      await this.postError(uri, NO_SECTIONS_MESSAGE, {
        requestId: request.requestId,
      });
      return null;
    }
    const store = this.getStore();
    const identity = this.identityOf(uri);
    const label = engineLabel(helpEngineConfig(readHelpSettings()));
    const outline = outlineOf(source);
    const title =
      clampField(request.fields.title, HELP_CAPS.title) ||
      titleOfSource(source, fileName);
    const sections: EditionSection[] = resolved.units.map((unit) => {
      const stats = sectionStats(source, unit);
      return {
        n: unit.n,
        heading: unit.heading,
        level: unit.level,
        line: unit.line,
        endLine: unit.endLine,
        words: stats.words,
        codeWords: stats.codeWords,
        tableWords: stats.tableWords,
        hash: sectionHash(sectionText(source, unit)),
        status: 'queued',
        actual: null,
        flagged: [],
        ms: null,
        anchor: anchorForUnit(unit),
      };
    });
    const sourceWords = sections.reduce((sum, s) => sum + s.words, 0);
    const estimate = estimateFor(sourceWords);
    const now = nowIso();
    const document = {
      workspace: identity.key.folder,
      path: identity.folder ? identity.key.document : uri.fsPath,
      absolute: uri.fsPath,
      title,
      headings: breadcrumbFor(outline, resolved.units[0]),
      words: countWords(source),
      git: this.git.knownFor(identity.folder?.fsPath ?? '') ?? {
        remote: '',
        commit: '',
      },
    };
    if (identity.folder) {
      void this.git.get(identity.folder.fsPath);
    }
    let record: EditionRecord;
    const cached = new Set<number>();
    if (request.editionId) {
      // §9.8 — Rebuild reuses the file.
      const old = store.get(identity.key, request.editionId);
      if (!old) {
        await this.postError(uri, EDITION_GONE_MESSAGE, {
          requestId: request.requestId,
        });
        return null;
      }
      if (this.jobFor(old.id)) {
        await this.postError(
          uri,
          'That edition is being written; wait for it or cancel it first.',
          { requestId: request.requestId },
        );
        return null;
      }
      if (this.isDirty(old.filePath)) {
        await this.postError(uri, DIRTY_EDITION_MESSAGE, {
          requestId: request.requestId,
        });
        return null;
      }
      const engineMatches =
        old.engine.engine === label.engine &&
        old.engine.model === label.model &&
        old.engine.effort === label.effort &&
        old.engine.prompt === RETELL_PROMPT_VERSION &&
        old.shape === DEFAULT_RETELL_SHAPE;
      const split = splitBody(old.body, old.sections);
      const reused: (string | null)[] = [];
      for (const section of sections) {
        const oldIndex = old.sections.findIndex(
          (candidate) =>
            candidate.status === 'done' &&
            candidate.hash === section.hash &&
            sameHeading(candidate.heading, section.heading),
        );
        const part = oldIndex >= 0 ? split.parts[oldIndex] : null;
        if (engineMatches && part !== null) {
          const previous = old.sections[oldIndex];
          section.status = 'done';
          section.actual = previous.actual;
          section.flagged = previous.flagged.slice();
          section.ms = previous.ms;
          cached.add(section.n);
          reused.push(part);
        } else {
          reused.push(null);
        }
      }
      const edition: ParsedEdition = {
        ...old,
        updated: now,
        finished: null,
        status: 'planning',
        stoppedAt: null,
        error: null,
        shape: DEFAULT_RETELL_SHAPE,
        scope: request.scope,
        engine: {
          engine: label.engine,
          model: label.model,
          effort: label.effort,
          prompt: RETELL_PROMPT_VERSION,
        },
        estimate: {
          sourceWords,
          words: estimate.words,
          minutes: estimate.minutes,
          ceiling: ceilingFor(sourceWords),
        },
        document: { ...document, git: old.document.git },
        sections,
        body: '',
      };
      let body = frameFor(edition);
      const editionDir = path.dirname(old.filePath);
      for (let i = 0; i < sections.length; i++) {
        const part = reused[i];
        if (part !== null) {
          body = appendSection(
            body,
            part,
            backLinkFor(edition, { line: sections[i].line }, editionDir),
          );
        }
      }
      edition.body = body;
      try {
        record = await store.update(identity.key, old.id, () => edition);
      } catch (error) {
        const message = `Could not write the edition file: ${reasonOf(error)}`;
        readAloudLog(`retell: rebuild failed: ${message}`);
        await this.postError(uri, message, { requestId: request.requestId });
        return null;
      }
      readAloudLog(
        `retell: rebuild ${old.id} (${cached.size} unchanged, ${sections.length - cached.size} re-called)`,
      );
    } else {
      const id = store.newId();
      const edition: ParsedEdition = {
        id,
        created: now,
        updated: now,
        finished: null,
        status: 'planning',
        stoppedAt: null,
        error: null,
        shape: DEFAULT_RETELL_SHAPE,
        scope: request.scope,
        engine: {
          engine: label.engine,
          model: label.model,
          effort: label.effort,
          prompt: RETELL_PROMPT_VERSION,
        },
        estimate: {
          sourceWords,
          words: estimate.words,
          minutes: estimate.minutes,
          ceiling: ceilingFor(sourceWords),
        },
        document,
        sections,
        unknown: {},
        body: '',
      };
      edition.body = initialBody(edition);
      try {
        record = await store.create(identity.key, edition);
      } catch (error) {
        const message = `Could not write the edition file: ${reasonOf(error)}`;
        readAloudLog(`retell: build failed: ${message}`);
        await this.postError(uri, message, { requestId: request.requestId });
        return null;
      }
    }
    const job: BuildJob = {
      editionId: record.id,
      key: identity.key,
      filePath: record.filePath,
      sourceUri: uri,
      editionUri: vscode.Uri.file(record.filePath),
      abort: new AbortController(),
      startedAt: Date.now(),
      cwd: null,
      opened: false,
      fileName,
      scope: request.scope,
      cached,
      fromContinue: false,
      onProgress: hooks.onProgress ?? null,
      onEnd: hooks.onEnd ?? null,
    };
    readAloudLog(
      `retell: build ${record.id} ${request.scope} ${sections.length} sections, ${sourceWords} words, ${label.engine} · ${label.model} · ${label.effort}`,
    );
    this.watchDocument(uri);
    this.enqueue(job, record);
    await this.postEditions(uri);
    return record.id;
  }

  private enqueue(job: BuildJob, record: ParsedEdition): void {
    this.queue.push(job);
    void this.postProgress(record, job, job.sourceUri, job.editionUri);
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
      if (next.onEnd) {
        try {
          next.onEnd();
        } catch {
          /* the notification is a courtesy */
        }
      }
      this.pump();
    });
  }

  // -------------------------------------------------------- the build loop

  private async readEdition(job: BuildJob): Promise<ParsedEdition> {
    const record = this.getStore().get(job.key, job.editionId);
    if (!record) {
      throw new BuildStopped('failed', EDITION_GONE_MESSAGE);
    }
    return record;
  }

  private isDirty(filePath: string): boolean {
    return vscode.workspace.textDocuments.some(
      (document) => document.uri.fsPath === filePath && document.isDirty,
    );
  }

  /** §9.5 — a dirty editor buffer is never overwritten. */
  private assertNotDirty(job: BuildJob): void {
    if (this.isDirty(job.filePath)) {
      throw new BuildStopped('stopped', DIRTY_EDITION_MESSAGE);
    }
  }

  private async write(
    job: BuildJob,
    mutate: (edition: ParsedEdition) => ParsedEdition,
  ): Promise<ParsedEdition> {
    this.assertNotDirty(job);
    return this.getStore().update(job.key, job.editionId, (edition) => {
      const next = mutate(edition);
      next.updated = nowIso();
      return next;
    });
  }

  /** §9.5 — after each write: let the TextDocument follow, then re-render. */
  private async refresh(job: BuildJob): Promise<void> {
    if (!this.deps.hasPreview(job.editionUri)) {
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
      await this.deps.refreshPreview(job.editionUri);
    } catch (error) {
      readAloudLog(`retell: refresh failed: ${String(error)}`);
    }
  }

  /** §9.1 — one engine call from the build's directory, the cache column logged. */
  private async callEngine(
    job: BuildJob,
    systemPrompt: string,
    userPrompt: string,
  ): Promise<HelpRunResult & { cache: string; cost: string }> {
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
      run.costUsd !== undefined ? `, cost $${run.costUsd.toFixed(4)}` : '';
    return { ...run, cache, cost };
  }

  private async runBuild(job: BuildJob): Promise<void> {
    const started = Date.now();
    try {
      job.cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'mpe-retell-'));
    } catch (error) {
      job.cwd = null;
      readAloudLog(`retell: no build directory: ${String(error)}`);
    }
    try {
      let edition = await this.readEdition(job);
      if (job.fromContinue) {
        readAloudLog(
          `retell: continue ${job.editionId} from ${edition.sections.filter((s) => s.status === 'done').length + 1}`,
        );
      }
      edition = await this.write(job, (current) => ({
        ...current,
        status: 'writing',
        stoppedAt: null,
        error: null,
        sections: current.sections.map((section) =>
          section.status === 'done'
            ? section
            : { ...section, status: 'queued' },
        ),
      }));
      await this.postProgress(edition, job, job.sourceUri, job.editionUri);
      const source = await this.readSource(job.sourceUri);
      const outline = outlineOf(source);
      const current = allUnits(source, { fileName: job.fileName });
      const systemPrompt = buildSystemPrompt();
      for (const section of edition.sections) {
        if (section.status === 'done') {
          if (job.cached.has(section.n)) {
            readAloudLog(
              `retell: section ${section.n}/${edition.sections.length} ${job.editionId} unchanged`,
            );
          }
          continue;
        }
        edition = await this.writeSection(
          job,
          edition,
          section.n,
          systemPrompt,
          source,
          outline,
          current,
        );
      }
      edition = await this.write(job, (current) => ({
        ...current,
        status: 'done',
        finished: nowIso(),
        stoppedAt: null,
        error: null,
      }));
      await this.maybeOpenBeside(job);
      await this.refresh(job);
      await this.postProgress(edition, null, job.sourceUri, job.editionUri);
      await this.postEditions(job.sourceUri);
      const words = edition.sections.reduce(
        (sum, s) => sum + (s.actual ?? 0),
        0,
      );
      const flagged = edition.sections.filter((s) => s.flagged.length).length;
      readAloudLog(
        `retell: done ${job.editionId} in ${Date.now() - started} (${words} words, ${flagged} flagged)`,
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

  /** §9.6 — Cancel, a dirty buffer, or a failed call: the file keeps what exists. */
  private async settleFailure(job: BuildJob, error: unknown): Promise<void> {
    const cancelled =
      job.abort.signal.aborted ||
      (error instanceof HelpEngineError && error.code === 'cancelled');
    const stopped =
      cancelled ||
      (error instanceof BuildStopped && error.status === 'stopped');
    const reason = cancelled ? null : reasonOf(error);
    let record: ParsedEdition | null;
    try {
      record = await this.getStore().update(
        job.key,
        job.editionId,
        (edition) => {
          const done = edition.sections.filter(
            (s) => s.status === 'done',
          ).length;
          return {
            ...edition,
            updated: nowIso(),
            status: stopped ? 'stopped' : 'failed',
            stoppedAt: done,
            error: reason,
            sections: edition.sections.map((section) =>
              section.status === 'writing'
                ? { ...section, status: stopped ? 'queued' : 'failed' }
                : section,
            ),
          };
        },
      );
    } catch (writeError) {
      readAloudLog(
        `retell: could not record the stop of ${job.editionId}: ${String(writeError)}`,
      );
      record = this.getStore().get(job.key, job.editionId);
    }
    const done = record
      ? record.sections.filter((s) => s.status === 'done').length
      : 0;
    if (stopped) {
      readAloudLog(`retell: stopped ${job.editionId} after ${done}`);
    } else {
      readAloudLog(`retell: failed ${job.editionId} at ${done + 1}: ${reason}`);
    }
    if (record) {
      await this.refresh(job);
      await this.postProgress(record, null, job.sourceUri, job.editionUri, {
        status: stopped ? 'stopped' : 'failed',
        error: reason,
      });
    }
    if (!stopped && reason) {
      await this.postError(
        job.sourceUri,
        reason,
        { editionId: job.editionId },
        true,
      );
    }
    await this.postEditions(job.sourceUri);
  }

  /** The unit of the current document a stored section stands for. */
  private currentUnitFor(
    section: EditionSection,
    current: SectionUnit[],
  ): SectionUnit {
    const byHeading = current.find((unit) =>
      sameHeading(unit.heading, section.heading),
    );
    if (byHeading) {
      return byHeading;
    }
    return {
      n: section.n,
      heading: section.heading,
      level: section.level,
      line: section.line,
      endLine: section.endLine,
      preamble: section.level === 1,
    };
  }

  /** §9.2–§9.5 — one unit: material, call, checks, one retry, sanitise, append. */
  private async writeSection(
    job: BuildJob,
    edition: ParsedEdition,
    n: number,
    systemPrompt: string,
    source: string,
    outline: OutlineHeading[],
    current: SectionUnit[],
  ): Promise<ParsedEdition> {
    const stored = edition.sections.find((section) => section.n === n);
    if (!stored) {
      throw new BuildStopped('failed', `The edition has no section ${n}.`);
    }
    const unit = this.currentUnitFor(stored, current);
    const text = sectionText(source, unit);
    const stats = sectionStats(source, unit);
    const hash = sectionHash(text);
    const started = Date.now();
    edition = await this.write(job, (currentEdition) => ({
      ...currentEdition,
      status: 'writing',
      sections: currentEdition.sections.map((s) =>
        s.n === n
          ? {
              ...s,
              status: 'writing',
              line: unit.line,
              endLine: unit.endLine,
              words: stats.words,
              codeWords: stats.codeWords,
              tableWords: stats.tableWords,
              hash,
              anchor: { ...s.anchor, line: unit.line },
            }
          : s,
      ),
    }));
    await this.postProgress(edition, job, job.sourceUri, job.editionUri);

    const of = edition.sections.length;
    const cut = cutSection(text);
    if (cut.cut > 0) {
      readAloudLog(
        `retell: section ${n} cut to ${RETELL_CAPS.section} of ${text.length} chars`,
      );
    }
    const material: RetellMaterial = {
      title: edition.document.title,
      breadcrumb: breadcrumbFor(outline, unit),
      outline: outlineText(outline, unit.line),
      section: cut.text,
      cut: cut.cut,
    };
    const estimate = estimateFor(stats.words).words;
    const brief: EditionCheckBrief = {
      sourceWords: stats.words,
      ceiling: ceilingFor(stats.words),
      under: underFor(stats.words),
      headings: headingsIn(outline, unit).map((heading) => ({
        level: heading.level,
        text: heading.text,
      })),
      title: edition.document.title,
    };
    const first = await this.callEngine(
      job,
      systemPrompt,
      buildFirstRequest(material, estimate),
    );
    const draft = normaliseHelpAnswer(first.markdown);
    let check: EditionCheckResult = checkEdition(draft, brief);
    let outcome = 'ok';
    let cache = first.cache;
    let cost = first.cost;
    let flagged: RetellCheckCode[] = check.failures.map((f) => f.code);
    const hard = check.failures.filter((f) => !f.soft);
    if (hard.length) {
      const codes = check.failures.map((f) => f.code);
      readAloudLog(
        `retell: section ${n}/${of} ${job.editionId} retry: ${codes.join(',')}`,
      );
      const second = await this.callEngine(
        job,
        systemPrompt,
        buildRetryRequest(
          material,
          estimate,
          draft,
          check.failures.map((f) => ({
            code: f.code,
            text: retellRuleText(f.code, brief, f.detail, check.words),
          })),
        ),
      );
      cache = second.cache;
      cost = second.cost;
      const again = checkEdition(normaliseHelpAnswer(second.markdown), brief);
      if (again.failures.some((f) => f.code === 'empty')) {
        await this.getStore().update(job.key, job.editionId, (current) => ({
          ...current,
          sections: current.sections.map((s) =>
            s.n === n
              ? { ...s, status: 'failed', ms: Date.now() - started }
              : s,
          ),
        }));
        throw new BuildStopped(
          'failed',
          `Section ${n} came back with nothing usable, twice.`,
        );
      }
      check = again;
      flagged = again.failures.map((f) => f.code);
      outcome = `retry: ${codes.join(',')}${
        flagged.length ? `; flagged: ${flagged.join(',')}` : ''
      }`;
    } else if (flagged.length) {
      outcome = `flagged: ${flagged.join(',')}`;
    }
    for (const note of check.notes) {
      readAloudLog(`retell: section ${n} ${job.editionId} note: ${note}`);
    }
    if (check.fixes.length) {
      readAloudLog(
        `retell: section ${n} ${job.editionId} fix: ${check.fixes.join(',')}`,
      );
    }
    let markdown = check.markdown;
    const deeper = writtenLevelOffset(stored);
    if (deeper) {
      // The preamble unit is headed by the document's h1; written one level
      // deeper so the file keeps exactly one h1, the frame's (§10.2).
      markdown = normaliseHeadings(markdown, -deeper);
    }
    markdown = sanitizeHelpAnswer(markdown);
    const ms = Date.now() - started;
    const git = job.key.folder
      ? (this.git.knownFor(this.folderPathOf(job.key)) ?? null)
      : null;
    const editionDir = path.dirname(job.filePath);
    const next = await this.write(job, (currentEdition) => {
      const at = currentEdition.sections.findIndex((s) => s.n === n);
      const lineOf = (index: number): number | null =>
        index === at
          ? unit.line
          : (currentEdition.sections[index]?.line ?? null);
      return {
        ...currentEdition,
        // In its place, not at the end: a Rebuild re-calls sections that sit
        // between reused ones (§9.8).
        body: placeSection(
          currentEdition.body,
          currentEdition.sections,
          n,
          markdown,
          (index) =>
            backLinkFor(currentEdition, { line: lineOf(index) }, editionDir),
        ),
        document:
          git && !currentEdition.document.git.commit
            ? { ...currentEdition.document, git: { ...git } }
            : currentEdition.document,
        sections: currentEdition.sections.map((s) =>
          s.n === n
            ? {
                ...s,
                status: 'done',
                actual: check.words,
                flagged: flagged.slice(),
                ms,
              }
            : s,
        ),
      };
    });
    const ratio = stats.words ? (check.words / stats.words).toFixed(2) : 'n/a';
    readAloudLog(
      `retell: section ${n}/${of} ${job.editionId} in ${ms} (${stats.words} → ${check.words} words, ratio ${ratio}, cache ${cache}, ${outcome}${cost})`,
    );
    await this.maybeOpenBeside(job);
    await this.refresh(job);
    await this.postProgress(next, job, job.sourceUri, job.editionUri);
    // The sheet's rows and the marker's badge read the summary (`7/18
    // sections`), which only the list carries; the store's own write never
    // wakes the watcher, so the list is re-posted here.
    await this.postEditions(job.sourceUri);
    return next;
  }

  /** §12.1 — open the edition beside the source at the first section, once. */
  private async maybeOpenBeside(job: BuildJob): Promise<void> {
    if (job.opened) {
      return;
    }
    job.opened = true;
    if (!readRetellSettings().autoOpen || this.deps.isSinglePreviewMode()) {
      return;
    }
    if (this.deps.hasPreview(job.editionUri)) {
      return;
    }
    try {
      await this.deps.openPreview(job.editionUri);
    } catch (error) {
      readAloudLog(`retell: open beside failed: ${String(error)}`);
    }
  }

  // ------------------------------------------------- cancel, continue, open

  /** The edition named by a request, reached from the document or from itself. */
  private recordFor(
    uriString: string,
    editionId: string,
  ): EditionRecord | null {
    const uri = vscode.Uri.parse(uriString);
    const store = this.getStore();
    const own = store.editionAt(uri.fsPath);
    if (own && own.id === editionId) {
      return own;
    }
    const { key } = this.identityOf(uri);
    return store.get(key, editionId);
  }

  private sourceUriOf(record: ParsedEdition): vscode.Uri {
    return vscode.Uri.file(record.document.absolute);
  }

  /** §9.6 — Cancel: abort the running call, or drop the queued build. */
  public async cancel(request: RetellCancelRequest): Promise<void> {
    if (this.deps.isWebBuild) {
      return;
    }
    const record = this.recordFor(request.sourceUri, request.editionId);
    if (!record) {
      return;
    }
    const job = this.jobFor(request.editionId);
    if (!job) {
      return;
    }
    readAloudLog(
      `retell: cancel ${request.editionId} (${request.reason || 'user'})`,
    );
    if (job === this.running) {
      job.abort.abort();
      return;
    }
    const at = this.queue.indexOf(job);
    if (at >= 0) {
      this.queue.splice(at, 1);
    }
    let stopped: ParsedEdition | null = null;
    try {
      stopped = await this.getStore().update(
        job.key,
        job.editionId,
        (edition) => ({
          ...edition,
          updated: nowIso(),
          status: 'stopped',
          stoppedAt: edition.sections.filter((s) => s.status === 'done').length,
        }),
      );
    } catch (error) {
      readAloudLog(`retell: could not record the cancel: ${String(error)}`);
    }
    if (stopped) {
      await this.postProgress(stopped, null, job.sourceUri, job.editionUri);
    }
    if (job.onEnd) {
      job.onEnd();
    }
  }

  /** §9.6 — Continue: re-read the file and resume from the first unit not done. */
  public async continueEdition(request: RetellEditionRequest): Promise<void> {
    if (this.deps.isWebBuild) {
      return;
    }
    const record = this.recordFor(request.sourceUri, request.editionId);
    const uri = vscode.Uri.parse(request.sourceUri);
    if (!record) {
      await this.postError(uri, EDITION_GONE_MESSAGE, {
        editionId: request.editionId,
      });
      return;
    }
    await this.continueRecord(record);
  }

  private async continueRecord(record: EditionRecord): Promise<void> {
    if (this.jobFor(record.id)) {
      return;
    }
    const adjusted = this.staleAdjusted(record);
    if (adjusted.status === 'done') {
      return;
    }
    const sourceUri = this.sourceUriOf(record);
    const job: BuildJob = {
      editionId: record.id,
      key: record.key,
      filePath: record.filePath,
      sourceUri,
      editionUri: vscode.Uri.file(record.filePath),
      abort: new AbortController(),
      startedAt: Date.now(),
      cwd: null,
      opened: this.deps.hasPreview(vscode.Uri.file(record.filePath)),
      fileName: fileNameOf(sourceUri),
      scope: record.scope,
      cached: new Set<number>(),
      fromContinue: true,
      onProgress: null,
      onEnd: null,
    };
    this.watchDocument(sourceUri);
    this.enqueue(job, { ...record, status: 'queued' });
  }

  /** §12.1 — Open: the edition's preview beside, or the single panel retargeted. */
  public async open(request: RetellEditionRequest): Promise<void> {
    if (this.deps.isWebBuild) {
      return;
    }
    const record = this.recordFor(request.sourceUri, request.editionId);
    if (!record) {
      await this.postError(
        vscode.Uri.parse(request.sourceUri),
        EDITION_GONE_MESSAGE,
        { editionId: request.editionId },
      );
      return;
    }
    await this.openEdition(record);
  }

  public async openEdition(record: EditionRecord): Promise<void> {
    try {
      await this.deps.openPreview(vscode.Uri.file(record.filePath));
    } catch (error) {
      readAloudLog(`retell: open edition failed: ${String(error)}`);
    }
  }

  /** §12.4 — _Open the source section_: the source preview, then the reveal. */
  public async openSource(request: RetellOpenSourceRequest): Promise<void> {
    if (this.deps.isWebBuild) {
      return;
    }
    const record = this.recordFor(request.editionUri, request.editionId);
    if (!record) {
      return;
    }
    const section =
      record.sections.find((s) => s.n === request.n) ?? record.sections[0];
    if (!section) {
      return;
    }
    const sourceUri = this.sourceUriOf(record);
    if (this.deps.hasPreview(sourceUri)) {
      await this.post(sourceUri, {
        command: 'readAloudControl',
        action: 'revealAnchor',
        anchor: anchorPayload(section.anchor),
        editionId: record.id,
      });
      return;
    }
    this.pendingReveal.set(sourceUri.toString(), {
      editionId: record.id,
      anchor: section.anchor,
    });
    try {
      await this.deps.openPreview(sourceUri);
    } catch (error) {
      this.pendingReveal.delete(sourceUri.toString());
      readAloudLog(`retell: open source failed: ${String(error)}`);
    }
  }

  /** §13 — _Open Spoken Editions Folder_. */
  public async openFolder(): Promise<void> {
    if (this.deps.isWebBuild) {
      void vscode.window.showInformationMessage(RETELL_WEB_BUILD_MESSAGE);
      return;
    }
    const root = vscode.Uri.file(this.getStore().editionsRoot);
    try {
      await vscode.workspace.fs.createDirectory(root);
    } catch {
      /* exists, or cannot be made: revealFileInOS says so */
    }
    await vscode.commands.executeCommand('revealFileInOS', root);
  }

  // ------------------------------------------------------- config, ready

  /** §14.3 — after the config handshake: the list, the pending reveal, the progress. */
  public onPreviewReady(uri: vscode.Uri): void {
    if (this.deps.isWebBuild || this.disposed) {
      return;
    }
    if (readRetellSettings().enabled && uri.scheme === 'file') {
      this.watchDocument(uri);
      void this.postEditions(uri);
    }
    const pending = this.pendingReveal.get(uri.toString());
    if (pending) {
      this.pendingReveal.delete(uri.toString());
      void this.post(uri, {
        command: 'readAloudControl',
        action: 'revealAnchor',
        anchor: anchorPayload(pending.anchor),
        editionId: pending.editionId,
      });
    }
    const edition = this.getStore().editionAt(uri.fsPath);
    if (edition) {
      const progress = this.lastProgress.get(edition.id);
      if (progress && this.jobFor(edition.id)) {
        void this.post(uri, {
          command: 'readAloudRetellProgress',
          ...progress,
        });
      }
    }
  }

  /** §12.2 — what an edition preview's `readAloudConfig` carries, or null. */
  public editionConfigFor(uri: vscode.Uri): RetellEditionConfig | null {
    if (this.deps.isWebBuild || uri.scheme !== 'file') {
      return null;
    }
    let record: EditionRecord | null;
    try {
      record = this.getStore().editionAt(uri.fsPath);
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
      sections: unitStates(adjusted),
      documentTitle: adjusted.document.title,
      documentPath: adjusted.document.path,
    };
  }

  // ---------------------------------------------------------------- delete

  /**
   * §11.3 — soft first: a build in the way is cancelled, the edition is
   * marked, the list is re-posted without it, and six seconds later the file
   * goes to the trash. `fromCommand` shows the information message with Undo
   * when no preview shows the document; the previews' chip does it otherwise.
   */
  public async delete(
    request: RetellEditionRequest,
    fromCommand: boolean = false,
  ): Promise<void> {
    if (this.deps.isWebBuild) {
      return;
    }
    const record = this.recordFor(request.sourceUri, request.editionId);
    if (!record) {
      await this.postError(
        vscode.Uri.parse(request.sourceUri),
        EDITION_GONE_MESSAGE,
        { editionId: request.editionId },
      );
      return;
    }
    const sourceUri = this.sourceUriOf(record);
    const editionUri = vscode.Uri.file(record.filePath);
    const job = this.jobFor(record.id);
    if (job) {
      await this.cancel({
        sourceUri: sourceUri.toString(),
        editionId: record.id,
        reason: 'delete',
      });
    }
    const store = this.getStore();
    const done = store.softDelete(record.key, record.id, UNDO_WINDOW_MS);
    readAloudLog(`retell: deleting ${record.id}`);
    await this.postEditions(sourceUri);
    if (this.deps.hasPreview(editionUri)) {
      await this.post(editionUri, {
        command: 'readAloudRetellEditions',
        sourceUri: editionUri.toString(),
        editions: [],
        deleting: [record.id],
        deleteMode: this.deleteMode(),
      });
    }
    if (fromCommand && !this.deps.hasPreview(sourceUri)) {
      const label =
        this.deleteMode() === 'trash'
          ? 'Spoken edition moved to Trash'
          : 'Spoken edition deleted';
      void vscode.window
        .showInformationMessage(label, 'Undo')
        .then((choice) => {
          if (choice === 'Undo') {
            void this.undoDelete({
              sourceUri: sourceUri.toString(),
              editionId: record.id,
            });
          }
        });
    }
    const outcome = await done;
    if (outcome === 'trash' || outcome === 'permanent') {
      readAloudLog(`retell: deleted ${record.id} (${outcome})`);
      this.lastProgress.delete(record.id);
      if (this.deps.hasPreview(editionUri)) {
        try {
          if (this.deps.isSinglePreviewMode()) {
            await this.deps.openPreview(sourceUri);
          } else {
            await this.deps.closePreview(editionUri);
          }
        } catch (error) {
          readAloudLog(
            `retell: close edition preview failed: ${String(error)}`,
          );
        }
      }
    }
    await this.postEditions(sourceUri);
  }

  public async undoDelete(request: RetellEditionRequest): Promise<void> {
    if (this.deps.isWebBuild) {
      return;
    }
    const record = this.recordFor(request.sourceUri, request.editionId);
    const store = this.getStore();
    if (store.undoDelete(request.editionId)) {
      readAloudLog(`retell: undo delete ${request.editionId}`);
    }
    const sourceUri = record
      ? this.sourceUriOf(record)
      : vscode.Uri.parse(request.sourceUri);
    await this.postEditions(sourceUri);
    if (record) {
      const editionUri = vscode.Uri.file(record.filePath);
      if (this.deps.hasPreview(editionUri)) {
        await this.post(editionUri, {
          command: 'readAloudRetellEditions',
          sourceUri: editionUri.toString(),
          editions: [],
          deleting: [],
          deleteMode: this.deleteMode(),
        });
      }
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

  private pickItems(records: EditionRecord[]) {
    return records.map((record) => {
      const summary = this.summaryOf(this.staleAdjusted(record));
      return {
        label: summary.title,
        description: `${record.document.workspace}/${record.document.path} · ${this.shortDate(
          record.created,
        )} · ${summary.sections} section${summary.sections === 1 ? '' : 's'} · ${summary.status}`,
        detail: record.sections.length ? record.sections[0].heading : '',
        record,
      };
    });
  }

  /** §13 — _Open Spoken Edition_: every edition across documents. */
  public async openQuickPick(): Promise<void> {
    if (this.deps.isWebBuild) {
      void vscode.window.showInformationMessage(RETELL_WEB_BUILD_MESSAGE);
      return;
    }
    const all = this.getStore().listAll();
    if (!all.editions.length) {
      void vscode.window.showInformationMessage(NO_EDITIONS_MESSAGE);
      return;
    }
    const picked = await vscode.window.showQuickPick(
      this.pickItems(all.editions),
      {
        placeHolder: 'Open a spoken edition',
        matchOnDescription: true,
        matchOnDetail: true,
      },
    );
    if (picked) {
      await this.openEdition(picked.record);
    }
  }

  /** §13 — _Continue Spoken Edition_. */
  public async continueCommand(activeEditionUri?: vscode.Uri): Promise<void> {
    if (this.deps.isWebBuild) {
      void vscode.window.showInformationMessage(RETELL_WEB_BUILD_MESSAGE);
      return;
    }
    const store = this.getStore();
    if (activeEditionUri) {
      const active = store.editionAt(activeEditionUri.fsPath);
      if (active) {
        const adjusted = this.staleAdjusted(active);
        if (adjusted.status === 'stopped' || adjusted.status === 'failed') {
          await this.continueRecord(active);
          return;
        }
      }
    }
    const candidates = store
      .listAll()
      .editions.map((record) => this.staleAdjusted(record))
      .filter(
        (record) => record.status === 'stopped' || record.status === 'failed',
      );
    if (!candidates.length) {
      void vscode.window.showInformationMessage(
        'No stopped or failed spoken edition to continue.',
      );
      return;
    }
    const picked = await vscode.window.showQuickPick(
      this.pickItems(candidates),
      {
        placeHolder: 'Continue a spoken edition',
        matchOnDescription: true,
        matchOnDetail: true,
      },
    );
    if (picked) {
      await this.continueRecord(picked.record);
    }
  }

  /** §13 — _Cancel Retell Build_. */
  public async cancelCommand(): Promise<void> {
    if (this.deps.isWebBuild) {
      void vscode.window.showInformationMessage(RETELL_WEB_BUILD_MESSAGE);
      return;
    }
    const jobs = [...(this.running ? [this.running] : []), ...this.queue];
    if (!jobs.length) {
      void vscode.window.showInformationMessage('No retell build is running.');
      return;
    }
    let target: BuildJob | undefined = jobs[0];
    if (jobs.length > 1) {
      const picked = await vscode.window.showQuickPick(
        jobs.map((job) => ({
          label: this.lastProgress.get(job.editionId)?.title ?? job.editionId,
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
        editionId: target.editionId,
        reason: 'palette',
      });
    }
  }

  /** §13 — _Delete Spoken Edition_: the active edition preview's, else a quick pick. */
  public async deleteCommand(activeEditionUri?: vscode.Uri): Promise<void> {
    if (this.deps.isWebBuild) {
      void vscode.window.showInformationMessage(RETELL_WEB_BUILD_MESSAGE);
      return;
    }
    const store = this.getStore();
    if (activeEditionUri) {
      const active = store.editionAt(activeEditionUri.fsPath);
      if (active) {
        await this.delete(
          { sourceUri: activeEditionUri.toString(), editionId: active.id },
          true,
        );
        return;
      }
    }
    const all = store.listAll();
    if (!all.editions.length) {
      void vscode.window.showInformationMessage(NO_EDITIONS_MESSAGE);
      return;
    }
    const picked = await vscode.window.showQuickPick(
      this.pickItems(all.editions),
      {
        placeHolder: 'Delete which spoken edition?',
        matchOnDescription: true,
        matchOnDetail: true,
      },
    );
    if (picked) {
      await this.delete(
        {
          sourceUri: vscode.Uri.file(picked.record.filePath).toString(),
          editionId: picked.record.id,
        },
        true,
      );
    }
  }

  /**
   * §13 — _Retell Document for Listening_: every unit of the document into
   * one edition. With a preview open the sheet shows the request; with none
   * a modal confirms and the build runs behind a progress notification.
   */
  public async documentCommand(uri: vscode.Uri | undefined): Promise<void> {
    if (this.deps.isWebBuild) {
      void vscode.window.showInformationMessage(RETELL_WEB_BUILD_MESSAGE);
      return;
    }
    if (!readRetellSettings().enabled) {
      void vscode.window.showInformationMessage(RETELL_DISABLED_MESSAGE);
      return;
    }
    if (!uri) {
      void vscode.window.showInformationMessage(
        'Open a markdown document, or its preview, first.',
      );
      return;
    }
    if (this.getStore().isEditionPath(uri.fsPath)) {
      void vscode.window.showInformationMessage(
        'This is a spoken edition already; open its source document to retell it.',
      );
      return;
    }
    if (this.deps.hasPreview(uri)) {
      await this.post(uri, {
        command: 'readAloudControl',
        action: 'retell',
        scope: 'document',
      });
      return;
    }
    const source = await this.readSource(uri);
    const fileName = fileNameOf(uri);
    const units = allUnits(source, { fileName });
    if (!units.length) {
      void vscode.window.showInformationMessage(NO_SECTIONS_MESSAGE);
      return;
    }
    const words = units.reduce(
      (sum, unit) => sum + sectionStats(source, unit).words,
      0,
    );
    const label = engineLabel(helpEngineConfig(readHelpSettings()));
    const choice = await vscode.window.showInformationMessage(
      `Retell all ${units.length} section${units.length === 1 ? '' : 's'} (${words.toLocaleString()} words) to ${label.engine}?`,
      { modal: true },
      'Retell',
    );
    if (choice !== 'Retell') {
      return;
    }
    const title = titleOfSource(source, fileName);
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Retelling ${fileName}`,
        cancellable: true,
      },
      (progress, token) =>
        new Promise<void>((resolve) => {
          let editionId: string | null = null;
          let ended = false;
          const end = () => {
            if (!ended) {
              ended = true;
              resolve();
            }
          };
          token.onCancellationRequested(() => {
            if (editionId) {
              void this.cancel({
                sourceUri: uri.toString(),
                editionId,
                reason: 'notification',
              });
            }
          });
          void this.build(
            {
              sourceUri: uri.toString(),
              requestId: `cmd-${Date.now().toString(36)}`,
              fields: {
                title,
                breadcrumb: [],
                before: '',
                after: '',
                section: '',
                enclosing: '',
                mentions: '',
                contextMode: 'document',
              },
              anchor: null,
              startLine: 1,
              endLine: 1,
              scope: 'document',
              editionId: null,
            },
            {
              onProgress: (state) => {
                if (state.status === 'writing' && state.section) {
                  progress.report({
                    message: `Section ${state.section} of ${state.of}`,
                  });
                } else if (state.status === 'queued') {
                  progress.report({
                    message: 'Waiting: another edition is being written',
                  });
                }
              },
              onEnd: end,
            },
          ).then((id) => {
            editionId = id;
            if (!id) {
              end();
            }
          });
        }),
    );
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
