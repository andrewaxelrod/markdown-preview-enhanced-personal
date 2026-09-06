import * as path from 'path';
import * as vscode from 'vscode';
import {
  normaliseHelpAnswer,
  sanitizeHelpAnswer,
} from '../read-aloud/help-answer';
import { GitInfoCache, type GitInfo } from '../read-aloud/git-info';
import {
  engineLabel,
  HelpEngineError,
  runHelpEngine,
  type HelpEngineDeps,
} from '../read-aloud/help-engine';
import {
  buildCodexPrompt,
  clampField,
  ENCLOSING_OPEN,
  HELP_CAPS,
  helpShapeFor,
  trimAroundPassage,
  type HelpFields,
} from '../read-aloud/help-prompt';
import { readAloudLog } from '../read-aloud/log';
import {
  HELP_FIELD_CAPS,
  type HelpFieldsPayload,
  type HostToWebviewMessage,
  type NoteAnchorsRequest,
  type NoteCreateRequest,
  type NoteIdRequest,
  type NoteOpenRequest,
  type NoteReattachRequest,
  type NoteRegenerateRequest,
  type NoteSummary,
  type NoteUpdateRequest,
  type ReadAloudNotesMessage,
} from '../read-aloud/messages';
import {
  readHelpSettings,
  readNotesSettings,
  type ReadAloudHelpSettings,
} from '../read-aloud/settings';
import { globalConfigPath } from '../utils';
import {
  applyGenerated,
  generatedMarkdown,
  generatedSectionsInOrder,
  isParseError,
  noteBodyForClipboard,
  summaryLineOf,
  titleFromPassage,
  type NoteExtraSection,
  type NoteSectionName,
  type ParsedNote,
} from './note-format';
import {
  buildNoteRequest,
  buildNoteSystemPrompt,
  NOTE_PROMPT_VERSION,
  parseNoteAnswer,
} from './note-prompt';
import {
  documentKeyFor,
  NoteMissingError,
  NotesStore,
  NoteUnreadableError,
  type DocumentKey,
  type NoteRecord,
  type WorkspaceFolderLike,
} from './notes-store';

/**
 * The notes controller (`featrues/12-notes/spec.md` §5, §7–§9, §11.4, §14):
 * capture, the generation queue, update, delete/undo, regenerate, reattach,
 * the anchors write-back, posting `readAloudNotes`, the clipboard, _Open in
 * editor_, the git fields and the pending reveal.
 *
 * Node-only, like the store and the engine (§3). The pure pieces — codec,
 * store, prompt — are tested on their own; this class is the `vscode` glue.
 */

export const NOTES_DIR_NAME = 'notes';
export const UNDO_WINDOW_MS = 6000;
export const MY_NOTE_DEBOUNCE_MS = 500;
export const NOTES_WEB_BUILD_MESSAGE =
  'Notes are not available in the web extension.';
/** 12 §8.1 — a `pending` older than this is shown with Regenerate enabled. */
export const PENDING_STALE_GRACE_MS = 60000;

export interface NotesControllerDeps {
  isWebBuild: boolean;
  engineDeps: HelpEngineDeps;
  getSinkFor(
    sourceUri: vscode.Uri,
  ): Promise<{ post(message: HostToWebviewMessage): Promise<void> }>;
  renderMarkdown(sourceUri: vscode.Uri, markdown: string): Promise<string>;
  getDocumentText(sourceUri: vscode.Uri): Promise<string | undefined>;
  hasPreview(sourceUri: vscode.Uri): boolean;
  openPreview(sourceUri: vscode.Uri): Promise<void>;
}

interface GenerationJob {
  sourceUri: vscode.Uri;
  key: DocumentKey;
  noteId: string;
  passage: string;
  fields: HelpFieldsPayload;
  abort: AbortController;
}

interface DocumentIdentity {
  key: DocumentKey;
  folder: WorkspaceFolderLike | null;
  relativePath: string;
}

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function fileNameOf(uri: vscode.Uri): string {
  return path.basename(uri.fsPath);
}

/** One line for the details chip and the log: the mapped reason of an engine error. */
function reasonOf(error: unknown): string {
  if (error instanceof HelpEngineError) {
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

export class NotesController implements vscode.Disposable {
  private readonly deps: NotesControllerDeps;
  private store: NotesStore | null = null;
  private storeRoot = '';
  private readonly watches = new Map<string, { dispose(): void }>();
  private readonly queue: GenerationJob[] = [];
  private running: GenerationJob | null = null;
  private readonly git = new GitInfoCache();
  private readonly htmlCache = new Map<string, { key: string; html: string }>();
  private readonly lastAnchors = new Map<string, string>();
  private readonly myNoteTimers = new Map<
    string,
    { timer: ReturnType<typeof setTimeout>; text: string; uri: vscode.Uri }
  >();
  private readonly pendingReveal = new Map<string, string>();
  private readonly changed = new vscode.EventEmitter<void>();
  private disposed = false;

  /** Fired after every store change, for the Notes view. */
  public readonly onDidChange = this.changed.event;

  constructor(deps: NotesControllerDeps) {
    this.deps = deps;
  }

  // ------------------------------------------------------------ the store

  /** §7.1 — the root: the setting, else `<globalConfigPath>/notes`. */
  public rootPath(): string {
    const settings = readNotesSettings();
    return settings.directory || path.join(globalConfigPath, NOTES_DIR_NAME);
  }

  private getStore(): NotesStore {
    const root = this.rootPath();
    if (this.store && this.storeRoot === root) {
      return this.store;
    }
    if (this.store) {
      for (const watch of this.watches.values()) {
        watch.dispose();
      }
      this.watches.clear();
      this.store.dispose();
    }
    this.storeRoot = root;
    this.store = new NotesStore({
      root,
      log: (line) => readAloudLog(line),
      trash: async (filePath) => {
        await vscode.workspace.fs.delete(vscode.Uri.file(filePath), {
          useTrash: true,
          recursive: false,
        });
        return true;
      },
    });
    return this.store;
  }

  /** The store, for the Notes view and the quick pick. */
  public get notesStore(): NotesStore {
    return this.getStore();
  }

  // --------------------------------------------------------------- identity

  private folders(): WorkspaceFolderLike[] {
    return (vscode.workspace.workspaceFolders ?? []).map((folder) => ({
      name: folder.name,
      fsPath: folder.uri.fsPath,
    }));
  }

  /** §7.2 — which folder of the store a document's notes live in. */
  public identityOf(uri: vscode.Uri): DocumentIdentity {
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

  /** The document a store folder key and document path stand for. */
  public documentUriFor(
    folderKey: string,
    documentPath: string,
    absolute?: string,
  ): vscode.Uri | null {
    if (absolute) {
      return vscode.Uri.file(absolute);
    }
    const folders = this.folders();
    for (const folder of folders) {
      if (
        documentKeyFor({
          folder,
          relativePath: '',
          absolutePath: folder.fsPath,
          folders,
        }).folder === folderKey
      ) {
        return vscode.Uri.file(
          path.join(folder.fsPath, ...documentPath.split('/')),
        );
      }
    }
    if (folderKey === '_no-workspace') {
      return vscode.Uri.file(path.sep + documentPath.split('/').join(path.sep));
    }
    return null;
  }

  // ----------------------------------------------------------- deleteMode

  /** §7.7 — whether a delete can end in the OS trash: locally, yes. */
  private deleteMode(): 'trash' | 'permanent' {
    return vscode.env.remoteName ? 'permanent' : 'trash';
  }

  // ------------------------------------------------------------- posting

  private async summaryOf(
    uri: vscode.Uri,
    note: NoteRecord,
  ): Promise<NoteSummary> {
    const sectionsMarkdown = sanitizeHelpAnswer(generatedMarkdown(note));
    const cacheKey = `${note.updated}:${sectionsMarkdown.length}:${sectionsMarkdown.slice(0, 200)}`;
    const cached = this.htmlCache.get(note.id);
    let html = '';
    if (cached && cached.key === cacheKey) {
      html = cached.html;
    } else if (sectionsMarkdown) {
      try {
        html = await this.deps.renderMarkdown(uri, sectionsMarkdown);
      } catch (error) {
        readAloudLog(`notes: render failed ${note.id}: ${String(error)}`);
        html = '';
      }
      this.htmlCache.set(note.id, { key: cacheKey, html });
    }
    const anchor: NoteSummary['anchor'] = {
      block: note.anchor.block,
      line: note.anchor.line,
      exact: note.anchor.exact,
      prefix: note.anchor.prefix,
      suffix: note.anchor.suffix,
      offset: note.anchor.offset,
      blocks: note.anchor.blocks,
    };
    if (note.anchor.lastSeen) {
      anchor.lastSeen = note.anchor.lastSeen;
    }
    if (note.anchor.missingSince) {
      anchor.missingSince = note.anchor.missingSince;
    }
    if (note.anchor.current) {
      anchor.current = { ...note.anchor.current };
    }
    return {
      id: note.id,
      title: note.title,
      titleEdited: note.titleEdited,
      shape: note.shape,
      created: note.created,
      updated: note.updated,
      headings: note.document.headings.slice(),
      passage: note.passage,
      anchor,
      generated: {
        status: note.generated.status,
        source: note.generated.source,
        engine: note.generated.engine,
        model: note.generated.model,
        effort: note.generated.effort,
        at: note.generated.at,
        error: note.generated.error,
      },
      tags: note.tags.slice(),
      myNote: note.myNote,
      html,
      sectionsMarkdown,
      sectionNames: generatedSectionsInOrder(note).map((s) => s.heading),
      context: { ...note.context },
      summaryLine: summaryLineOf(note),
    };
  }

  /** §14.3 — the whole list of a document, to every panel showing it. */
  public async postNotes(uri: vscode.Uri): Promise<void> {
    if (this.deps.isWebBuild || this.disposed) {
      return;
    }
    try {
      const store = this.getStore();
      const { key } = this.identityOf(uri);
      const listing = store.list(key);
      const deleting = store.deletingIds();
      const visible = listing.notes.filter((n) => !deleting.includes(n.id));
      const notes: NoteSummary[] = [];
      for (const note of visible) {
        notes.push(await this.summaryOf(uri, note));
      }
      const message: ReadAloudNotesMessage = {
        command: 'readAloudNotes',
        sourceUri: uri.toString(),
        notes,
        deleting: listing.notes
          .filter((n) => deleting.includes(n.id))
          .map((n) => n.id),
        deleteMode: this.deleteMode(),
        generate: readNotesSettings().generate,
      };
      const sink = await this.deps.getSinkFor(uri);
      await sink.post(message);
      readAloudLog(`notes: posted ${notes.length} for ${fileNameOf(uri)}`);
    } catch (error) {
      readAloudLog(
        `notes: post failed for ${fileNameOf(uri)}: ${String(error)}`,
      );
    }
    this.changed.fire();
  }

  private async postError(
    uri: vscode.Uri,
    message: string,
    ids: { noteId?: string; requestId?: string },
  ): Promise<void> {
    try {
      const sink = await this.deps.getSinkFor(uri);
      await sink.post({
        command: 'readAloudNoteError',
        message,
        ...ids,
      });
    } catch (error) {
      readAloudLog(`notes: error post failed: ${String(error)}`);
    }
  }

  private async postControl(uri: vscode.Uri, noteId: string): Promise<void> {
    try {
      const sink = await this.deps.getSinkFor(uri);
      await sink.post({
        command: 'readAloudControl',
        action: 'showNote',
        noteId,
      });
    } catch (error) {
      readAloudLog(`notes: showNote post failed: ${String(error)}`);
    }
  }

  /**
   * §14.3 — after the config handshake: the document's list rides with the
   * config, the folder is watched (§7.6) and a pending reveal is flushed.
   */
  public onPreviewReady(uri: vscode.Uri): void {
    if (this.deps.isWebBuild || this.disposed) {
      return;
    }
    if (!readNotesSettings().enabled) {
      return;
    }
    this.watchDocument(uri);
    void this.postNotes(uri).then(() => {
      const pending = this.pendingReveal.get(uri.toString());
      if (pending) {
        this.pendingReveal.delete(uri.toString());
        void this.postControl(uri, pending);
      }
    });
  }

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
        void this.postNotes(uri);
      }),
    );
  }

  // --------------------------------------------------------------- capture

  /** §5.2 steps 3–4 — validate, write, post, queue. */
  public async create(request: NoteCreateRequest): Promise<void> {
    const uri = vscode.Uri.parse(request.sourceUri);
    if (this.deps.isWebBuild) {
      await this.postError(uri, NOTES_WEB_BUILD_MESSAGE, {
        requestId: request.requestId,
      });
      return;
    }
    const settings = readNotesSettings();
    const store = this.getStore();
    const identity = this.identityOf(uri);
    const now = nowIso();
    const id = store.newId();
    const passage = clampField(request.passage, HELP_CAPS.passage);
    const title =
      clampField(request.fields.title, HELP_CAPS.title) || fileNameOf(uri);
    const sections = new Map<NoteSectionName, string>();
    let generated: ParsedNote['generated'];
    if (request.source === 'help' && request.explanation) {
      sections.set(
        'Explanation',
        sanitizeHelpAnswer(normaliseHelpAnswer(request.explanation)),
      );
      generated = { status: 'done', source: 'help', at: now };
    } else if (settings.generate) {
      generated = { status: 'pending', source: 'engine' };
    } else {
      generated = { status: 'done' };
    }
    const note: ParsedNote = {
      id,
      created: now,
      updated: now,
      shape: helpShapeFor(passage),
      titleEdited: false,
      document: {
        workspace: identity.key.folder,
        path: identity.folder ? identity.key.document : uri.fsPath,
        absolute: uri.fsPath,
        title,
        headings: request.fields.breadcrumb.slice(
          0,
          HELP_CAPS.breadcrumbLevels,
        ),
        git: this.git.knownFor(identity.folder?.fsPath ?? '') ?? {
          remote: '',
          commit: '',
        },
      },
      anchor: { ...request.anchor, lastSeen: now },
      generated,
      tags: [],
      unknown: {},
      title: titleFromPassage(passage),
      passage,
      sections,
      extras: [],
      myNote: '',
      context: {
        enclosing: trimAroundPassage(
          clampField(request.fields.enclosing, HELP_FIELD_CAPS.enclosing),
          HELP_CAPS.enclosing,
          ENCLOSING_OPEN,
        ),
        before: clampField(request.fields.before, HELP_CAPS.before),
        after: clampField(request.fields.after, HELP_CAPS.after),
      },
    };
    let record: NoteRecord;
    try {
      record = await store.create(
        identity.key,
        note,
        identity.folder ? identity.folder.fsPath : undefined,
      );
    } catch (error) {
      const message = `Could not write the note file under ${store.documentDir(identity.key)}: ${
        error instanceof Error ? error.message : String(error)
      }`;
      readAloudLog(`notes: create failed: ${message}`);
      await this.postError(uri, message, { requestId: request.requestId });
      return;
    }
    readAloudLog(
      `notes: created ${id} (${passage.length}, ${note.context.enclosing.length}) → ${path.basename(record.filePath)}`,
    );
    this.watchDocument(uri);
    await this.postNotes(uri);
    if (identity.folder) {
      void this.git.get(identity.folder.fsPath);
    }
    if (request.source !== 'help' && settings.generate) {
      this.enqueue({
        sourceUri: uri,
        key: identity.key,
        noteId: id,
        passage,
        fields: request.fields,
        abort: new AbortController(),
      });
    }
  }

  // ------------------------------------------------------------ generation

  private enqueue(job: GenerationJob): void {
    this.queue.push(job);
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
    void this.generate(next).finally(() => {
      this.running = null;
      this.pump();
    });
  }

  /** §8.2 — the material: help's fields, capped and trimmed as help does. */
  private async buildFields(
    uri: vscode.Uri,
    passage: string,
    payload: HelpFieldsPayload,
    help: ReadAloudHelpSettings,
  ): Promise<HelpFields> {
    const contextMode = payload.contextMode;
    const fields: HelpFields = {
      title: clampField(payload.title, HELP_CAPS.title) || fileNameOf(uri),
      breadcrumb: payload.breadcrumb
        .slice(0, HELP_CAPS.breadcrumbLevels)
        .map((level) => clampField(level, HELP_CAPS.breadcrumbLevel))
        .filter((level) => level.length > 0),
      before: clampField(payload.before, HELP_CAPS.before),
      after: clampField(payload.after, HELP_CAPS.after),
      section: trimAroundPassage(
        clampField(payload.section, HELP_FIELD_CAPS.section),
        HELP_CAPS.section,
      ),
      enclosing: trimAroundPassage(
        clampField(payload.enclosing, HELP_FIELD_CAPS.enclosing),
        HELP_CAPS.enclosing,
        ENCLOSING_OPEN,
      ),
      mentions: clampField(payload.mentions, HELP_CAPS.mentions),
      passage: clampField(passage, HELP_CAPS.passage),
      contextMode,
    };
    if (contextMode !== 'document' || help.contextMode !== 'document') {
      if (fields.contextMode === 'document') {
        fields.contextMode = 'section';
      }
      return fields;
    }
    let source: string | undefined;
    try {
      source = await this.deps.getDocumentText(uri);
    } catch (error) {
      readAloudLog(`notes: document read failed: ${String(error)}`);
    }
    if (!source || source.length > HELP_CAPS.document) {
      fields.contextMode = 'section';
      return fields;
    }
    fields.document = source;
    return fields;
  }

  private async generate(job: GenerationJob): Promise<void> {
    const help = readHelpSettings();
    const config = {
      engine: help.engine,
      claudeModel: help.claudeModel,
      claudeEffort: help.claudeEffort,
      codexModel: help.codexModel,
      codexEffort: help.codexEffort,
      command: help.command,
      timeoutSeconds: help.timeoutSeconds,
      binaryPath: help.binaryPath,
    };
    const label = engineLabel(config);
    const started = Date.now();
    try {
      const fields = await this.buildFields(
        job.sourceUri,
        job.passage,
        job.fields,
        help,
      );
      const systemPrompt = buildNoteSystemPrompt(help.audience);
      const userPrompt = buildNoteRequest(fields);
      readAloudLog(
        `notes: generating ${job.noteId} ${label.engine} · ${label.model} · ${label.effort}, ${fields.contextMode}, ${userPrompt.length}`,
      );
      const run = await runHelpEngine(
        {
          config,
          systemPrompt,
          userPrompt,
          codexPrompt: buildCodexPrompt(systemPrompt, userPrompt),
          signal: job.abort.signal,
        },
        this.deps.engineDeps,
      );
      const markdown = normaliseHelpAnswer(run.markdown);
      if (!markdown) {
        throw new HelpEngineError(
          'engine_empty',
          `${label.engine} returned an empty answer.`,
          true,
        );
      }
      if (job.abort.signal.aborted) {
        return;
      }
      const parts = parseNoteAnswer(markdown, job.passage);
      // §15 — every generated string is sanitised before it is written.
      const safeSections = new Map<NoteSectionName, string>();
      for (const [name, text] of parts.sections) {
        safeSections.set(name, sanitizeHelpAnswer(text));
      }
      const safeExtras: NoteExtraSection[] = parts.extras.map((extra) => ({
        heading: sanitizeHelpAnswer(extra.heading),
        markdown: sanitizeHelpAnswer(extra.markdown),
      }));
      const safeParts = {
        ...parts,
        title: sanitizeHelpAnswer(parts.title),
        sections: safeSections,
        extras: safeExtras,
      };
      const at = nowIso();
      const git: GitInfo | null =
        this.git.knownFor(this.folderPathOf(job.key)) ?? null;
      await this.getStore().update(job.key, job.noteId, (note) => {
        const next = applyGenerated(note, safeParts);
        next.generated = {
          status: 'done',
          source: 'engine',
          engine: label.engine,
          model: label.model,
          effort: label.effort,
          prompt: NOTE_PROMPT_VERSION,
          at,
        };
        next.updated = at;
        if (git && !next.document.git.commit) {
          next.document.git = { ...git };
        }
        return next;
      });
      readAloudLog(
        `notes: generated ${job.noteId} in ${Date.now() - started} (${markdown.length}, ${parts.tags.length} tags)`,
      );
      await this.postNotes(job.sourceUri);
    } catch (error) {
      if (error instanceof HelpEngineError && error.code === 'cancelled') {
        return;
      }
      if (job.abort.signal.aborted) {
        return;
      }
      const reason = reasonOf(error);
      readAloudLog(`notes: generation failed ${job.noteId}: ${reason}`);
      const at = nowIso();
      try {
        await this.getStore().update(job.key, job.noteId, (note) => ({
          ...note,
          updated: at,
          generated: {
            status: 'error',
            source: 'engine',
            engine: label.engine,
            model: label.model,
            effort: label.effort,
            prompt: NOTE_PROMPT_VERSION,
            at,
            error: reason,
          },
        }));
      } catch (writeError) {
        readAloudLog(
          `notes: could not record the failure of ${job.noteId}: ${String(writeError)}`,
        );
      }
      await this.postNotes(job.sourceUri);
      await this.postError(
        job.sourceUri,
        `The summary could not be written. ${reason}`,
        { noteId: job.noteId },
      );
    }
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

  // --------------------------------------------------------------- update

  /** §7.4, §11.1 — title and tags at once; _My note_ debounced per note. */
  public async update(request: NoteUpdateRequest): Promise<void> {
    if (this.deps.isWebBuild) {
      return;
    }
    const uri = vscode.Uri.parse(request.sourceUri);
    const { key } = this.identityOf(uri);
    if (request.title !== undefined || request.tags !== undefined) {
      await this.write(uri, key, request.noteId, (note) => {
        const next = { ...note, updated: nowIso() };
        if (request.title !== undefined) {
          next.title = request.title;
          next.titleEdited = true;
        }
        if (request.tags !== undefined) {
          next.tags = request.tags.slice();
        }
        return next;
      });
      readAloudLog(
        `notes: updated ${request.noteId} (${[
          request.title !== undefined ? 'title' : '',
          request.tags !== undefined ? 'tags' : '',
        ]
          .filter(Boolean)
          .join(', ')})`,
      );
      await this.postNotes(uri);
    }
    if (request.myNote !== undefined) {
      const existing = this.myNoteTimers.get(request.noteId);
      if (existing) {
        clearTimeout(existing.timer);
      }
      const text = request.myNote;
      this.myNoteTimers.set(request.noteId, {
        uri,
        text,
        timer: setTimeout(() => {
          this.myNoteTimers.delete(request.noteId);
          void this.flushMyNote(uri, key, request.noteId, text);
        }, MY_NOTE_DEBOUNCE_MS),
      });
    }
  }

  private async flushMyNote(
    uri: vscode.Uri,
    key: DocumentKey,
    noteId: string,
    text: string,
  ): Promise<void> {
    const written = await this.write(uri, key, noteId, (note) =>
      note.myNote === text
        ? null
        : { ...note, myNote: text, updated: nowIso() },
    );
    if (written) {
      readAloudLog(`notes: updated ${noteId} (myNote)`);
      this.changed.fire();
    }
  }

  /** One serialised rewrite with the two error paths of §7.4 mapped. */
  private async write(
    uri: vscode.Uri,
    key: DocumentKey,
    noteId: string,
    mutate: (note: ParsedNote) => ParsedNote | null,
  ): Promise<boolean> {
    try {
      await this.getStore().update(key, noteId, mutate);
      return true;
    } catch (error) {
      if (error instanceof NoteUnreadableError) {
        await this.postError(
          uri,
          'The note file could not be updated; open it to check it.',
          { noteId },
        );
      } else if (error instanceof NoteMissingError) {
        await this.postError(uri, 'The note file is gone.', { noteId });
        await this.postNotes(uri);
      } else {
        await this.postError(
          uri,
          `The note could not be saved: ${error instanceof Error ? error.message : String(error)}`,
          { noteId },
        );
      }
      readAloudLog(`notes: update failed ${noteId}: ${String(error)}`);
      return false;
    }
  }

  // --------------------------------------------------------------- delete

  /**
   * §7.7 — soft first. `fromView` shows the information message with Undo
   * when no preview shows the document; the preview's chip does it otherwise.
   */
  public async delete(
    request: NoteIdRequest,
    fromView: boolean = false,
  ): Promise<void> {
    if (this.deps.isWebBuild) {
      return;
    }
    const uri = vscode.Uri.parse(request.sourceUri);
    const { key } = this.identityOf(uri);
    const store = this.getStore();
    const pending = this.myNoteTimers.get(request.noteId);
    if (pending) {
      clearTimeout(pending.timer);
      this.myNoteTimers.delete(request.noteId);
    }
    const done = store.softDelete(key, request.noteId, UNDO_WINDOW_MS);
    await this.postNotes(uri);
    if (fromView && !this.deps.hasPreview(uri)) {
      const label =
        this.deleteMode() === 'trash' ? 'Note moved to Trash' : 'Note deleted';
      void vscode.window
        .showInformationMessage(label, 'Undo')
        .then((choice) => {
          if (choice === 'Undo') {
            void this.undoDelete(request);
          }
        });
    }
    const outcome = await done;
    if (outcome === 'trash' || outcome === 'permanent') {
      readAloudLog(`notes: deleted ${request.noteId} (${outcome})`);
      this.htmlCache.delete(request.noteId);
      this.lastAnchors.delete(request.noteId);
    }
    await this.postNotes(uri);
  }

  public async undoDelete(request: NoteIdRequest): Promise<void> {
    if (this.deps.isWebBuild) {
      return;
    }
    const uri = vscode.Uri.parse(request.sourceUri);
    if (this.getStore().undoDelete(request.noteId)) {
      readAloudLog(`notes: undo delete ${request.noteId}`);
    }
    await this.postNotes(uri);
  }

  // ------------------------------------------------------------ regenerate

  /** §8.4 — fresh material when anchored, the stored context when orphaned. */
  public async regenerate(request: NoteRegenerateRequest): Promise<void> {
    if (this.deps.isWebBuild) {
      return;
    }
    const uri = vscode.Uri.parse(request.sourceUri);
    const { key } = this.identityOf(uri);
    let record: ParsedNote | null = null;
    const written = await this.write(uri, key, request.noteId, (note) => {
      record = note;
      return {
        ...note,
        updated: nowIso(),
        generated: {
          ...note.generated,
          status: 'pending',
          source: 'engine',
          error: undefined,
        },
      };
    });
    if (!written || !record) {
      return;
    }
    const note = record as ParsedNote;
    const fields: HelpFieldsPayload = request.fields ?? {
      title: note.document.title,
      breadcrumb: note.document.headings.slice(),
      before: '',
      after: '',
      section: '',
      enclosing: note.context.enclosing,
      mentions: '',
      contextMode: 'selection',
    };
    await this.postNotes(uri);
    this.enqueue({
      sourceUri: uri,
      key,
      noteId: request.noteId,
      passage: note.passage,
      fields,
      abort: new AbortController(),
    });
  }

  // -------------------------------------------------------------- reattach

  /** §11.3 — a fresh anchor as `current`; the original is kept. */
  public async reattach(request: NoteReattachRequest): Promise<void> {
    if (this.deps.isWebBuild) {
      return;
    }
    const uri = vscode.Uri.parse(request.sourceUri);
    const { key } = this.identityOf(uri);
    const now = nowIso();
    const written = await this.write(uri, key, request.noteId, (note) => {
      const anchor = { ...note.anchor };
      if (!anchor.original) {
        anchor.original = { block: anchor.block, line: anchor.line };
      }
      anchor.current = {
        block: request.anchor.block,
        line: request.anchor.line,
      };
      anchor.lastSeen = now;
      delete anchor.missingSince;
      return {
        ...note,
        updated: now,
        anchor,
        document: {
          ...note.document,
          headings: request.breadcrumb.slice(0, HELP_CAPS.breadcrumbLevels),
        },
      };
    });
    if (written) {
      this.lastAnchors.delete(request.noteId);
      readAloudLog(`notes: reattached ${request.noteId}`);
      await this.postNotes(uri);
    }
  }

  // --------------------------------------------------------------- anchors

  /**
   * §9.4 — the webview's report after an anchoring pass: coalesced per note,
   * written as `anchor.current`, `lastSeen` or `missingSince`. Nothing is
   * posted back, or the pass would run again.
   */
  public async anchors(request: NoteAnchorsRequest): Promise<void> {
    if (this.deps.isWebBuild) {
      return;
    }
    const uri = vscode.Uri.parse(request.sourceUri);
    const { key } = this.identityOf(uri);
    const store = this.getStore();
    let found = 0;
    for (const report of request.anchors) {
      if (report.found) {
        found++;
      }
      const signature = JSON.stringify(report);
      if (this.lastAnchors.get(report.noteId) === signature) {
        continue;
      }
      this.lastAnchors.set(report.noteId, signature);
      try {
        await store.update(key, report.noteId, (note) => {
          const anchor = { ...note.anchor };
          const now = nowIso();
          if (report.found) {
            delete anchor.missingSince;
            const block = report.block ?? anchor.block;
            const line = report.line === undefined ? anchor.line : report.line;
            if (block !== anchor.block || line !== anchor.line) {
              anchor.current = { block, line };
            } else {
              delete anchor.current;
            }
            // Found: `lastSeen` moves every time, so this is always a write.
            anchor.lastSeen = now;
            return { ...note, anchor, updated: now };
          }
          if (anchor.missingSince) {
            return null;
          }
          anchor.missingSince = now;
          return { ...note, anchor, updated: now };
        });
      } catch (error) {
        readAloudLog(
          `notes: anchor write failed ${report.noteId}: ${String(error)}`,
        );
      }
    }
    readAloudLog(
      `notes: anchors ${found}/${request.anchors.length} for ${fileNameOf(uri)}`,
    );
    this.changed.fire();
  }

  // ----------------------------------------------------------- open, copy

  /** §11.4 — _Open in editor_ (the anchor line, centred) or the note file. */
  public async open(request: NoteOpenRequest): Promise<void> {
    if (this.deps.isWebBuild) {
      return;
    }
    const uri = vscode.Uri.parse(request.sourceUri);
    const note = this.recordOf(uri, request.noteId);
    if (!note) {
      await this.postError(uri, 'The note file is gone.', {
        noteId: request.noteId,
      });
      return;
    }
    if (request.target === 'file') {
      await this.openNoteFile(note.filePath);
      return;
    }
    await this.openInEditor(uri, note);
  }

  public async openNoteFile(filePath: string): Promise<void> {
    const document = await vscode.workspace.openTextDocument(
      vscode.Uri.file(filePath),
    );
    await vscode.window.showTextDocument(document, { preview: false });
  }

  public async openInEditor(uri: vscode.Uri, note: ParsedNote): Promise<void> {
    const line = note.anchor.current?.line ?? note.anchor.line;
    const document = await vscode.workspace.openTextDocument(uri);
    const target = Math.max(
      0,
      Math.min(document.lineCount - 1, typeof line === 'number' ? line : 0),
    );
    const range = new vscode.Range(target, 0, target, 0);
    const visible = vscode.window.visibleTextEditors.find(
      (editor) => editor.document.uri.toString() === uri.toString(),
    );
    const editor = await vscode.window.showTextDocument(document, {
      viewColumn: visible ? visible.viewColumn : vscode.ViewColumn.Beside,
      preview: false,
      selection: range,
    });
    editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
  }

  /** §11.4 — _Copy as markdown_. */
  public async copy(request: NoteIdRequest): Promise<void> {
    if (this.deps.isWebBuild) {
      return;
    }
    const uri = vscode.Uri.parse(request.sourceUri);
    const note = this.recordOf(uri, request.noteId);
    if (!note) {
      await this.postError(uri, 'The note file is gone.', {
        noteId: request.noteId,
      });
      return;
    }
    await vscode.env.clipboard.writeText(noteBodyForClipboard(note));
  }

  public recordOf(uri: vscode.Uri, noteId: string): NoteRecord | null {
    const store = this.getStore();
    const { key } = this.identityOf(uri);
    const filePath = store.find(key, noteId);
    if (!filePath) {
      return null;
    }
    const parsed = store.read(filePath);
    return isParseError(parsed) ? null : { ...parsed, filePath };
  }

  // --------------------------------------------------------- the view side

  /** §12 — _All notes_: focus the Notes view. */
  public async showAll(): Promise<void> {
    try {
      await vscode.commands.executeCommand(
        'markdown-preview-enhanced.notes.focus',
      );
    } catch (error) {
      readAloudLog(`notes: focus view failed: ${String(error)}`);
    }
  }

  /**
   * §13.1 — _Reveal in preview_: open the preview when none shows the
   * document, then `showNote` — at once, or after the handshake.
   */
  public async revealInPreview(uri: vscode.Uri, noteId: string): Promise<void> {
    if (this.deps.isWebBuild) {
      void vscode.window.showInformationMessage(NOTES_WEB_BUILD_MESSAGE);
      return;
    }
    if (this.deps.hasPreview(uri)) {
      await this.postNotes(uri);
      await this.postControl(uri, noteId);
      return;
    }
    this.pendingReveal.set(uri.toString(), noteId);
    try {
      await this.deps.openPreview(uri);
    } catch (error) {
      this.pendingReveal.delete(uri.toString());
      readAloudLog(`notes: open preview failed: ${String(error)}`);
    }
  }

  // -------------------------------------------------------------- dispose

  public dispose(): void {
    this.disposed = true;
    for (const pending of this.myNoteTimers.values()) {
      clearTimeout(pending.timer);
    }
    this.myNoteTimers.clear();
    if (this.running) {
      this.running.abort.abort();
      this.running = null;
    }
    this.queue.length = 0;
    for (const watch of this.watches.values()) {
      watch.dispose();
    }
    this.watches.clear();
    this.store?.dispose();
    this.store = null;
    this.changed.dispose();
  }
}
