import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  CACHE_DIR_NAME,
  cachedDurationHint,
  cacheKey,
  ReadAloudCache,
  type CacheEntry,
} from './cache';
import { planReadChunks, type Chunk } from './chunker';
import {
  CANCELLED_CODE,
  kokoroErrorInfo,
  mapKokoroErrorToAction,
  NETWORK_ERROR_CODE,
  userMessageFor,
  type ErrorAction,
  type ReadAloudErrorInfo,
} from './error-mapping';
import { normaliseHelpAnswer, sanitizeHelpAnswer } from './help-answer';
import {
  HELP_CACHE_DIR_NAME,
  helpCacheKey,
  ReadAloudHelpCache,
} from './help-cache';
import {
  CLAUDE_EFFORTS,
  CLAUDE_MODEL_ALIASES,
  CODEX_EFFORTS,
  CLAUDE_MODEL_RE,
  defaultHelpEngineDeps,
  engineLabel,
  HelpEngineError,
  runHelpEngine,
  type HelpEngineConfig,
  type HelpEngineDeps,
} from './help-engine';
import {
  buildCodexPrompt,
  buildFirstRequest,
  buildFollowUp,
  buildSystemPrompt,
  clampField,
  ENCLOSING_OPEN,
  followUpFor,
  HELP_CAPS,
  helpShapeFor,
  normaliseQuestion,
  PASSAGE_MARKER,
  trimAroundPassage,
  wordTargetForPassage,
  type HelpFields,
} from './help-prompt';
import { alignKokoroWords } from './kokoro-alignment';
import {
  DEFAULT_KOKORO_VOICE,
  KOKORO_MODEL_ID,
  KOKORO_REQUEST_LIMIT_CHARS,
  KOKORO_TIMEOUT_MS,
  KokoroCancelledError,
  KokoroClient,
  KokoroHttpError,
  KokoroNetworkError,
  type ResponseMeta,
} from './kokoro-client';
import { chooseKokoroVoiceQuickPick } from './kokoro-voices';
import {
  disposeReadAloudLog,
  logRequest,
  readAloudLog,
  showReadAloudLog,
} from './log';
import {
  type ClassroomModuleConfig,
  type RetellEditionConfig,
  HELP_FIELD_CAPS,
  type CancelRequest,
  type HelpRequest,
  type HostToWebviewMessage,
  type PlayingRequest,
  type ReadAloudConfigMessage,
  type ReadAloudControlMessage,
  type ReadAloudControlAction,
  type ReadAloudFont,
  type ReadAloudGlobalTheme,
  type ReadAloudHighlightTheme,
  type ReadAloudKind,
  type ReadAloudWordMarker,
  type SynthesizeRequest,
} from './messages';
import {
  clearPageSettings,
  readHelpSettings,
  readReadAloudSettings,
  writeFontSetting,
  writeGlobalThemeSetting,
  writeHelpModelSettings,
  writeHighlightThemeSetting,
  writeSpeedSetting,
  writeTextSizeSetting,
  writeVolumeSetting,
  writeWordMarkerSetting,
  type ReadAloudHelpSettings,
  type ReadAloudSettingKey,
  type ReadAloudSettings,
} from './settings';
import {
  mapSpanBack,
  sanitizeForSpeech,
  type SpeakableText,
} from './speakable';
import type { WordSpan } from './word-spans';

/**
 * The host-side read-aloud state machine (F10–F13, contract §3.7).
 *
 * One job at a time, one request in flight at a time, by construction: a new
 * `readAloudSynthesize` supersedes the running job, and every job ends with
 * exactly one terminal event — the last `readAloudAudio` or a single
 * `readAloudError`.
 */

const WEB_BUILD_MESSAGE =
  'Read aloud is not available in VS Code for the Web (v1).';
/** §11 check 12 — the help button is absent in the web build; `Alt+H` says so. */
const HELP_WEB_BUILD_MESSAGE = 'Help is not available in the web extension.';
/** Notes (12 §3) — desktop only; `Alt+N` and `Alt+Shift+N` say so on the web. */
const NOTES_WEB_BUILD_MESSAGE = 'Notes are not available in the web extension.';
const CLASSROOM_WEB_BUILD_MESSAGE =
  'Classroom is not available in the web extension.';
const CLASSROOM_CONTROL_ACTIONS: ReadAloudControlAction[] = [
  'classroom',
  'classroomModule',
];
/** Retell (15 §3) — desktop only; `Alt+T` and `Alt+Shift+T` say so on the web. */
const RETELL_WEB_BUILD_MESSAGE =
  'Retell is not available in the web extension.';
const RETELL_CONTROL_ACTIONS: ReadAloudControlAction[] = [
  'retell',
  'retellEdition',
];
const NOTE_CONTROL_ACTIONS: ReadAloudControlAction[] = [
  'note',
  'notesList',
  'showNote',
];
const SETUP_CHOOSE_VOICE = 'Choose Read Aloud Voice';
const SETUP_SHOW_LOG = 'Show Read Aloud Log';
const SETUP_CHECK_KOKORO = 'Check Kokoro Server';
const BYTES_PER_MB = 1048576;

/**
 * Prefetch depth (F11, performance pass 2026-09-03): the request for chunk
 * *k* goes out as soon as the previous response is in, as long as *k* is
 * within PREFETCH_CHUNKS of the chunk the webview reports playing. With the
 * chunker's ~45 s chunks that keeps about 90 s of audio synthesised ahead of
 * playback, which is what carries a continuous read across block boundaries
 * without an audible gap: the next block's first chunk is ready while the
 * current block's last chunk plays. A stop wastes at most two chunks of local
 * synthesis. Cache hits are never held: they cost nothing.
 */
export const PREFETCH_CHUNKS = 2;

/** Where a `readAloudAudio` / `readAloudError` message is delivered. */
export interface PreviewSink {
  post(message: HostToWebviewMessage): Promise<void>;
}

/** Everything the controller needs from `preview-provider.ts` (lane C). */
export interface ControllerDeps {
  isWebBuild: boolean;
  getSinkFor(sourceUri: vscode.Uri): Promise<PreviewSink>;
  postToAll(
    message: HostToWebviewMessage,
    exceptSourceUri?: string,
  ): Promise<void>;
  refreshAllPreviews(): void;
  /**
   * Help §6 — the model's markdown through the *preview's own* engine, so the
   * explanation carries the same markdown-it plugins, the same classes and
   * the same code-span and list markup as the document around it.
   */
  renderMarkdown(sourceUri: vscode.Uri, markdown: string): Promise<string>;
  /** Help §3.1 — the markdown source, for `readAloudHelpContext = document`. */
  getDocumentText(sourceUri: vscode.Uri): Promise<string | undefined>;
}

/** One block of a read, as the host sees it (decision 5). */
interface JobBlock {
  /** Index in the request's block list (0 for a request without blocks). */
  index: number;
  /** The webview's content hash of the block; for the log only. */
  key: string;
  /** Where the block's slice starts in the webview's request text. */
  start: number;
  /** The speakable text of the slice and the map back into the slice. */
  speakable: SpeakableText;
}

interface Job {
  sourceUri: string;
  requestId: string;
  kind: ReadAloudKind;
  blocks: JobBlock[];
  abort: AbortController;
  remaining: Chunk[];
  posted: number;
  inFlight: boolean;
  /** Highest chunk index the webview has reported playing; −1 before the first. */
  playing: number;
  /** Resolves the pending {@link waitForPrefetchWindow}, if any. */
  wake: (() => void) | null;
  budget: {
    backoff: number;
  };
  sink: PreviewSink;
}

type Recovery = { kind: 'backoff'; delayMs: number };

/** Closure-local state of one `run(job)` (A-16): never reachable from `this`. */
interface RunState {
  planned: boolean;
  terminated: boolean;
  recovery: Recovery | null;
  settings: ReadAloudSettings;
  client: KokoroClient;
  voiceId: string;
  locale: string;
}

type Classified =
  | { kind: 'aborted' }
  | { kind: 'error'; info: ReadAloudErrorInfo; action: ErrorAction };

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const pending: { timer?: ReturnType<typeof setTimeout> } = {};
    const onAbort = () => {
      if (pending.timer !== undefined) {
        clearTimeout(pending.timer);
      }
      resolve();
    };
    pending.timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function normalizeUri(value: string): string {
  try {
    return vscode.Uri.parse(value).toString();
  } catch {
    return value;
  }
}

/** What one server request yields for one chunk, before caching and posting. */
interface Synthesized {
  audioBase64: string;
  spans: WordSpan[] | null;
  durationHint: number | undefined;
  meta: ResponseMeta;
}

function metaOfError(error: unknown): ResponseMeta | undefined {
  return error instanceof KokoroHttpError ? error.meta : undefined;
}

/** The settings shape the engine wants (§7.1 -> §7.2); notes reuse it (12 §8.1). */
export function helpEngineConfig(
  help: ReadAloudHelpSettings,
): HelpEngineConfig {
  return {
    engine: help.engine,
    claudeModel: help.claudeModel,
    claudeEffort: help.claudeEffort,
    codexModel: help.codexModel,
    codexEffort: help.codexEffort,
    command: help.command,
    timeoutSeconds: help.timeoutSeconds,
    binaryPath: help.binaryPath,
  };
}

/**
 * §14.2, `document` mode — put `[PASSAGE]` where the passage starts in the
 * markdown source. The passage is *extracted* text, so it never matches the
 * source byte for byte: the first few words are turned into a whitespace-
 * tolerant pattern instead. When they cannot be found the marker is left out
 * and the caller logs it, exactly as §14.2 says.
 */
export function insertPassageMarker(source: string, passage: string): string {
  const words = passage.trim().split(/\s+/).filter(Boolean).slice(0, 8);
  if (words.length === 0) {
    return source;
  }
  const pattern = words
    .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('[\\s\\S]{0,40}?');
  let match: RegExpExecArray | null;
  try {
    match = new RegExp(pattern).exec(source);
  } catch {
    match = null;
  }
  if (!match) {
    readAloudLog(
      'help context=document: passage not found in the source; no marker',
    );
    return source;
  }
  return `${source.slice(0, match.index)}\n${PASSAGE_MARKER}\n${source.slice(match.index)}`;
}

let instance: ReadAloudController | undefined;

/** One help request (§4): at most one in flight, a new one supersedes it. */
interface HelpJob {
  sourceUri: string;
  requestId: string;
  abort: AbortController;
}

export class ReadAloudController implements vscode.Disposable {
  private readonly deps: ControllerDeps;
  private readonly cache: ReadAloudCache;
  private readonly helpCache: ReadAloudHelpCache;
  private readonly helpEngineDeps: HelpEngineDeps;
  private webNoticeShown = false;
  private job: Job | null = null;
  private helpJob: HelpJob | null = null;
  /**
   * Notes (12 §14.3) and classroom (13 §14.3): called right after the config
   * handshake of a preview, so the document's `readAloudNotes` rides with the
   * config and a pending reveal is flushed. Added by `extension-common.ts`.
   */
  private readonly configListeners: ((sourceUri: vscode.Uri) => void)[] = [];
  /**
   * Classroom (13 §12.2): what a module preview's config carries, or null for
   * any other document. Set by `extension-common.ts`.
   */
  public moduleConfigFor:
    ((sourceUri: vscode.Uri) => ClassroomModuleConfig | null) | null = null;
  /**
   * Retell (15 §12.2): what an edition preview's config carries, or null for
   * any other document. Set by `extension-common.ts`.
   */
  public editionConfigFor:
    ((sourceUri: vscode.Uri) => RetellEditionConfig | null) | null = null;

  public addConfigListener(listener: (sourceUri: vscode.Uri) => void): void {
    this.configListeners.push(listener);
  }

  private constructor(context: vscode.ExtensionContext, deps: ControllerDeps) {
    this.deps = deps;
    const dir = path.join(context.globalStorageUri.fsPath, CACHE_DIR_NAME);
    this.cache = new ReadAloudCache(
      dir,
      readReadAloudSettings().cacheSizeMB * BYTES_PER_MB,
    );
    this.helpCache = new ReadAloudHelpCache(
      path.join(context.globalStorageUri.fsPath, HELP_CACHE_DIR_NAME),
    );
    this.helpEngineDeps = defaultHelpEngineDeps((line) => readAloudLog(line));
  }

  /** Idempotent. */
  public static init(
    context: vscode.ExtensionContext,
    deps: ControllerDeps,
  ): ReadAloudController {
    if (!instance) {
      instance = new ReadAloudController(context, deps);
    }
    return instance;
  }

  public static get(): ReadAloudController {
    if (!instance) {
      throw new Error('ReadAloudController not initialized');
    }
    return instance;
  }

  public static getIfInitialized(): ReadAloudController | undefined {
    return instance;
  }

  // ---------------------------------------------------------------- commands

  /** F8 — the `Choose Read Aloud Voice` QuickPick over the server's voices. */
  public async chooseVoiceCommand(): Promise<void> {
    if (this.guardWebBuild()) {
      return;
    }
    try {
      const settings = readReadAloudSettings();
      const picked = await chooseKokoroVoiceQuickPick(
        this.makeKokoroClient(settings.kokoroBaseUrl),
      );
      if (!picked) {
        return;
      }
      await this.broadcastConfig();
    } catch (error) {
      this.reportCommandError(error);
    }
  }

  /** F12 — the `Clear Read Aloud Cache` command. */
  public async clearCacheCommand(): Promise<void> {
    if (this.guardWebBuild()) {
      return;
    }
    try {
      const removed = this.cache.clear();
      // D10 — the same command empties the help answers.
      const help = this.helpCache.clear();
      void vscode.window.showInformationMessage(
        `Read aloud cache cleared (${removed} audio entries, ${help} help answers).`,
      );
    } catch (error) {
      this.reportCommandError(error);
    }
  }

  public showLogCommand(): void {
    if (this.guardWebBuild()) {
      return;
    }
    showReadAloudLog();
  }

  /** The webview's `readAloudOpenSetup` (F13) and the setup entry point. */
  public async openSetup(): Promise<void> {
    if (this.guardWebBuild()) {
      return;
    }
    try {
      const settings = readReadAloudSettings();
      const picked = await vscode.window.showQuickPick(
        [SETUP_CHECK_KOKORO, SETUP_CHOOSE_VOICE, SETUP_SHOW_LOG],
        { placeHolder: 'Read aloud setup (Kokoro)' },
      );
      if (picked === SETUP_CHECK_KOKORO) {
        await this.checkKokoroServer(settings.kokoroBaseUrl);
      } else if (picked === SETUP_CHOOSE_VOICE) {
        await this.chooseVoiceCommand();
      } else if (picked === SETUP_SHOW_LOG) {
        showReadAloudLog();
      }
    } catch (error) {
      this.reportCommandError(error);
    }
  }

  /** `GET /health` and `GET /v1/audio/voices` on the Kokoro server, reported in a notification. */
  private async checkKokoroServer(baseUrl: string): Promise<void> {
    const client = this.makeKokoroClient(baseUrl);
    const status = await client.health();
    const { voices } = await client.listVoices();
    void vscode.window.showInformationMessage(
      `Kokoro server at ${client.url}: ${status}, ${voices.length} voices available.`,
    );
  }

  /** F3/F13 — `readAloudControl` from a command or keybinding. */
  public async control(
    action: ReadAloudControlAction,
    noteId?: string,
    extra?: Partial<ReadAloudControlMessage>,
  ): Promise<void> {
    if (action === 'help' && this.deps.isWebBuild) {
      // §11 check 12 — the web build has no help button, and `Alt+H` says why
      // rather than falling through to the generic read-aloud notice.
      void vscode.window.showInformationMessage(HELP_WEB_BUILD_MESSAGE);
      return;
    }
    if (NOTE_CONTROL_ACTIONS.includes(action) && this.deps.isWebBuild) {
      void vscode.window.showInformationMessage(NOTES_WEB_BUILD_MESSAGE);
      return;
    }
    if (CLASSROOM_CONTROL_ACTIONS.includes(action) && this.deps.isWebBuild) {
      void vscode.window.showInformationMessage(CLASSROOM_WEB_BUILD_MESSAGE);
      return;
    }
    if (RETELL_CONTROL_ACTIONS.includes(action) && this.deps.isWebBuild) {
      void vscode.window.showInformationMessage(RETELL_WEB_BUILD_MESSAGE);
      return;
    }
    if (this.guardWebBuild()) {
      return;
    }
    try {
      const message: ReadAloudControlMessage = {
        command: 'readAloudControl',
        action,
      };
      if (noteId) {
        message.noteId = noteId;
      }
      if (extra) {
        Object.assign(message, extra);
      }
      await this.deps.postToAll(message);
    } catch (error) {
      readAloudLog(`control ${action} failed: ${String(error)}`);
    }
  }

  /** The process glue the help engine runs with; notes generate through it (12 §8.1). */
  public get engineDeps(): HelpEngineDeps {
    return this.helpEngineDeps;
  }

  /** The preview sinks and the markdown renderer, shared with the notes controller. */
  public get previewDeps(): ControllerDeps {
    return this.deps;
  }

  /** F13 `readAloudSetSpeed`: persist only; the broadcast follows the setting change. */
  public async setSpeed(rate: number): Promise<void> {
    if (this.guardWebBuild()) {
      return;
    }
    try {
      await writeSpeedSetting(rate);
    } catch (error) {
      readAloudLog(`speed persist failed: ${String(error)}`);
    }
  }

  /** F13 `readAloudSetVolume`: the control panel's volume slider (F3). */
  public async setVolume(level: number): Promise<void> {
    if (this.guardWebBuild()) {
      return;
    }
    try {
      await writeVolumeSetting(level);
    } catch (error) {
      readAloudLog(`volume persist failed: ${String(error)}`);
    }
  }

  /**
   * F13 `readAloudSetHighlightTheme`: a swatch of the theme settings sheet.
   * The webview has already repainted; this only persists the choice, and the
   * setting change broadcasts it to every other preview.
   */
  public async setHighlightTheme(
    theme: ReadAloudHighlightTheme,
  ): Promise<void> {
    if (this.guardWebBuild()) {
      return;
    }
    try {
      await writeHighlightThemeSetting(theme);
    } catch (error) {
      readAloudLog(`highlight theme persist failed: ${String(error)}`);
    }
  }

  /** F13 `readAloudSetFont`: the theme settings sheet's player font. */
  public async setFont(font: ReadAloudFont): Promise<void> {
    if (this.guardWebBuild()) {
      return;
    }
    try {
      await writeFontSetting(font);
    } catch (error) {
      readAloudLog(`font persist failed: ${String(error)}`);
    }
  }

  // ---------------------------------------------- the low-strain page (05)

  /**
   * `readAloudSetGlobalTheme`: a segment of the Global theme control. The
   * webview has already switched the page; the setting change broadcasts it
   * to every other preview (05 §4.4).
   */
  public async setGlobalTheme(theme: ReadAloudGlobalTheme): Promise<void> {
    if (this.guardWebBuild()) {
      return;
    }
    try {
      await writeGlobalThemeSetting(theme);
    } catch (error) {
      readAloudLog(`global theme persist failed: ${String(error)}`);
    }
  }

  /** `readAloudSetTextSize`: the sheet's text size slider (07 §5). */
  public async setTextSize(value: number): Promise<void> {
    if (this.guardWebBuild()) {
      return;
    }
    try {
      await writeTextSizeSetting(value);
    } catch (error) {
      readAloudLog(`text size persist failed: ${String(error)}`);
    }
  }

  /** `readAloudSetWordMarker`: the sheet's word marker row (07 §9.3). */
  public async setWordMarker(style: ReadAloudWordMarker): Promise<void> {
    if (this.guardWebBuild()) {
      return;
    }
    try {
      await writeWordMarkerSetting(style);
    } catch (error) {
      readAloudLog(`word marker persist failed: ${String(error)}`);
    }
  }

  /**
   * `readAloudResetPage`: clears the four page settings (05 §9.4, D16). The
   * settings-change broadcast then carries the defaults to every preview.
   */
  public async resetPage(): Promise<void> {
    if (this.guardWebBuild()) {
      return;
    }
    try {
      await clearPageSettings();
    } catch (error) {
      readAloudLog(`page settings reset failed: ${String(error)}`);
    }
  }

  // ------------------------------------------------------------------- help

  /**
   * §7.1 — the _Choose Help Model_ quick pick: the model, then the effort,
   * for whichever engine is in use. Writing the settings broadcasts a new
   * `readAloudConfig`, which is what re-labels an open sheet at once.
   */
  public async chooseHelpModelCommand(): Promise<void> {
    if (this.guardWebBuild()) {
      return;
    }
    try {
      const help = readHelpSettings();
      if (help.engine === 'custom') {
        void vscode.window.showInformationMessage(
          'The help engine is set to `custom`, which takes its whole command from markdown-preview-enhanced.readAloudHelpCommand. Switch readAloudHelpEngine to claude or codex to choose a model here.',
        );
        return;
      }
      const model = await this.pickHelpModel(help);
      if (model === undefined) {
        return;
      }
      const effort = await this.pickHelpEffort(help);
      if (effort === undefined) {
        return;
      }
      await writeHelpModelSettings(help.engine, model, effort);
      readAloudLog(
        `help model set engine=${help.engine} model=${model || '(default)'} effort=${effort}`,
      );
    } catch (error) {
      this.reportCommandError(error);
    }
  }

  private async pickHelpModel(
    help: ReadAloudHelpSettings,
  ): Promise<string | undefined> {
    const ENTER = 'Enter a model id…';
    if (help.engine === 'claude') {
      const items = CLAUDE_MODEL_ALIASES.map((alias) => ({
        label: alias,
        description:
          alias === help.claudeModel
            ? "the CLI's latest model of that name (current)"
            : "the CLI's latest model of that name",
      }));
      const picked = await vscode.window.showQuickPick(
        [
          ...items,
          { label: ENTER, description: 'a full id, e.g. claude-fable-5' },
        ],
        { placeHolder: `Help model for claude (now: ${help.claudeModel})` },
      );
      if (!picked) {
        return undefined;
      }
      if (picked.label !== ENTER) {
        return picked.label;
      }
      const typed = await vscode.window.showInputBox({
        prompt: 'Model id for claude --model',
        value: help.claudeModel,
        validateInput: (value) =>
          CLAUDE_MODEL_RE.test(value.trim())
            ? undefined
            : 'Use fable, opus, sonnet, haiku, or a full claude-… id.',
      });
      return typed === undefined ? undefined : typed.trim();
    }
    const typed = await vscode.window.showInputBox({
      prompt: 'Model id for codex -m (empty uses the CLI’s configured default)',
      value: help.codexModel,
      placeHolder: 'gpt-5.6-sol',
    });
    return typed === undefined ? undefined : typed.trim();
  }

  private async pickHelpEffort(
    help: ReadAloudHelpSettings,
  ): Promise<string | undefined> {
    // D6 — effort is a trade the listener feels: they are waiting with a read
    // paused, so the cost of each level is spelled out rather than implied.
    const descriptions: Record<string, string> = {
      default: "no override; the CLI's configured effort answers",
      none: 'no reasoning at all — fastest, weakest',
      minimal: 'barely any reasoning',
      low: 'a few seconds (default)',
      medium: 'thinks a little longer',
      high: 'thinks noticeably longer, costs more per answer',
      xhigh: 'slower still; for genuinely hard material',
      max: 'the most thinking the model will do',
      ultra: 'beyond max, where the model accepts it',
    };
    const current =
      help.engine === 'claude' ? help.claudeEffort : help.codexEffort;
    const levels: readonly string[] =
      help.engine === 'claude' ? CLAUDE_EFFORTS : CODEX_EFFORTS;
    const picked = await vscode.window.showQuickPick(
      levels.map((level) => ({
        label: level,
        description:
          (descriptions[level] ?? '') + (level === current ? ' (current)' : ''),
      })),
      { placeHolder: `Effort for ${help.engine} (now: ${current})` },
    );
    return picked?.label;
  }

  /**
   * §9 `readAloudHelp`. Resolves once the answer (or the error) has been
   * posted. One request in flight per preview: a new one supersedes the old,
   * killing its child.
   */
  public async help(request: HelpRequest): Promise<void> {
    if (this.deps.isWebBuild) {
      await this.postHelpError(
        request.sourceUri,
        request.requestId,
        HELP_WEB_BUILD_MESSAGE,
        false,
      );
      return;
    }

    const sourceUri = normalizeUri(request.sourceUri);
    this.cancelHelp('superseded');
    const job: HelpJob = {
      sourceUri,
      requestId: request.requestId,
      abort: new AbortController(),
    };
    this.helpJob = job;

    const help = readHelpSettings();
    const started = Date.now();
    try {
      const fields = await this.buildHelpFields(request, help);
      const words = wordTargetForPassage(request.passage);
      // 11 — a passage of a few words is a term: its own first-request task
      // line and its own follow-up texts.
      const shape = helpShapeFor(request.passage);
      const question = request.question
        ? normaliseQuestion(request.question)
        : '';
      const followUp = request.followUp
        ? followUpFor(request.followUp, words, question, shape)
        : null;
      const finalWords = followUp ? followUp.words : words;
      const previous = request.previous
        ? clampField(request.previous, HELP_CAPS.previous)
        : '';

      const systemPrompt = buildSystemPrompt(help.audience);
      const userPrompt = followUp
        ? buildFollowUp(fields, previous, followUp.request, finalWords)
        : buildFirstRequest(fields, finalWords);
      const config = helpEngineConfig(help);
      const label = engineLabel(config);

      const key = helpCacheKey({
        engine: label.engine,
        model: label.model,
        effort: label.effort,
        audience: help.audience,
        contextMode: fields.contextMode,
        title: fields.title,
        breadcrumb: fields.breadcrumb.join(' > '),
        before: fields.before,
        passage: fields.passage,
        after: fields.after,
        section:
          fields.contextMode === 'document'
            ? (fields.document ?? '')
            : fields.section,
        enclosing: fields.enclosing ?? '',
        mentions: fields.mentions ?? '',
        question: followUp ? `${request.followUp}:${question}` : '',
        previous,
      });

      const cached = this.helpCache.get(key);
      let markdown: string;
      let cacheState: 'hit' | 'miss' = 'hit';
      if (cached) {
        markdown = cached.markdown;
      } else {
        cacheState = 'miss';
        const run = await runHelpEngine(
          {
            config,
            systemPrompt,
            userPrompt,
            codexPrompt: buildCodexPrompt(systemPrompt, userPrompt),
            signal: job.abort.signal,
          },
          this.helpEngineDeps,
        );
        markdown = normaliseHelpAnswer(run.markdown);
        if (!markdown) {
          throw new HelpEngineError(
            'engine_empty',
            `${label.engine} returned an empty answer.`,
            true,
          );
        }
        this.helpCache.set(key, {
          markdown,
          engine: label.engine,
          model: label.model,
          effort: label.effort,
          createdAt: Date.now(),
        });
      }

      if (job.abort.signal.aborted) {
        return;
      }

      // §6 — the answer is untrusted markdown, so every `<` is escaped and
      // every executable link target neutralised *before* the preview engine
      // is allowed anywhere near it.
      const html = await this.deps.renderMarkdown(
        vscode.Uri.parse(request.sourceUri),
        sanitizeHelpAnswer(markdown),
      );
      if (job.abort.signal.aborted) {
        return;
      }
      const durationMs = Date.now() - started;
      this.logHelp(request, help, label, cacheState, userPrompt.length, {
        durationMs,
      });
      if (this.helpJob === job) {
        this.helpJob = null;
      }
      const sink = await this.deps.getSinkFor(
        vscode.Uri.parse(request.sourceUri),
      );
      await sink.post({
        command: 'readAloudHelpResult',
        requestId: request.requestId,
        html,
        markdown,
        engine: label.engine,
        model: label.model,
        effort: label.effort,
        cached: cacheState === 'hit',
        durationMs,
      });
    } catch (error) {
      if (this.helpJob === job) {
        this.helpJob = null;
      }
      if (error instanceof HelpEngineError && error.code === 'cancelled') {
        return;
      }
      if (job.abort.signal.aborted) {
        return;
      }
      const label = engineLabel(helpEngineConfig(help));
      const message =
        error instanceof HelpEngineError
          ? error.message
          : `Help failed: ${error instanceof Error ? error.message : String(error)}`;
      const retryable =
        error instanceof HelpEngineError ? error.retryable : true;
      this.logHelp(request, help, label, 'miss', 0, {
        durationMs: Date.now() - started,
        error: error instanceof HelpEngineError ? error.code : 'unknown',
      });
      await this.postHelpError(
        request.sourceUri,
        request.requestId,
        message,
        retryable,
      );
    }
  }

  /** §9 `readAloudHelpCancel`; a no-op for anything but the running request. */
  public helpCancel(cancel: CancelRequest): void {
    if (this.deps.isWebBuild) {
      return;
    }
    const job = this.helpJob;
    if (
      !job ||
      job.requestId !== cancel.requestId ||
      job.sourceUri !== normalizeUri(cancel.sourceUri)
    ) {
      return;
    }
    this.cancelHelp(cancel.reason ?? 'webview');
  }

  private cancelHelp(reason: string): void {
    const job = this.helpJob;
    if (!job) {
      return;
    }
    this.helpJob = null;
    job.abort.abort();
    readAloudLog(`help cancelled req=${job.requestId} reason=${reason}`);
  }

  /**
   * §3.1 — the fields the prompt is assembled from, capped here rather than in
   * the webview so the caps are the host's, and with `document` mode's source
   * read from the open document.
   */
  private async buildHelpFields(
    request: HelpRequest,
    help: ReadAloudHelpSettings,
  ): Promise<HelpFields> {
    const contextMode = help.contextMode;
    const fields: HelpFields = {
      title: clampField(request.title, HELP_CAPS.title),
      breadcrumb: request.breadcrumb
        .slice(0, HELP_CAPS.breadcrumbLevels)
        .map((level) => clampField(level, HELP_CAPS.breadcrumbLevel))
        .filter((level) => level.length > 0),
      before: clampField(request.before, HELP_CAPS.before),
      after: clampField(request.after, HELP_CAPS.after),
      // `messages.ts` allows a wider section than the prompt wants, so the
      // even trim around `[PASSAGE]` happens here rather than by a front cut
      // at the boundary (§14.2).
      section: trimAroundPassage(
        clampField(request.section, HELP_FIELD_CAPS.section),
        HELP_CAPS.section,
      ),
      // 11 — the passage's own block, trimmed around its ⟦ marker the way
      // the section is around [PASSAGE]; the mentions are cut from the front.
      enclosing: trimAroundPassage(
        clampField(request.enclosing, HELP_FIELD_CAPS.enclosing),
        HELP_CAPS.enclosing,
        ENCLOSING_OPEN,
      ),
      mentions: clampField(request.mentions, HELP_CAPS.mentions),
      passage: clampField(request.passage, HELP_CAPS.passage),
      contextMode,
    };
    if (contextMode !== 'document') {
      return fields;
    }
    let source: string | undefined;
    try {
      source = await this.deps.getDocumentText(
        vscode.Uri.parse(request.sourceUri),
      );
    } catch (error) {
      readAloudLog(`help document read failed: ${String(error)}`);
    }
    if (!source) {
      readAloudLog('help context=document: no document text; using section');
      fields.contextMode = 'section';
      return fields;
    }
    if (source.length > HELP_CAPS.document) {
      readAloudLog(
        `help context=document: ${source.length} chars is over the ${HELP_CAPS.document} cap; using section`,
      );
      fields.contextMode = 'section';
      return fields;
    }
    fields.document = insertPassageMarker(source, fields.passage);
    return fields;
  }

  private async postHelpError(
    sourceUri: string,
    requestId: string,
    message: string,
    retryable: boolean,
  ): Promise<void> {
    try {
      const sink = await this.deps.getSinkFor(vscode.Uri.parse(sourceUri));
      await sink.post({
        command: 'readAloudHelpError',
        requestId,
        message,
        retryable,
      });
    } catch (error) {
      readAloudLog(`help error post failed req=${requestId}: ${String(error)}`);
    }
  }

  /** §4 — one line per request; character counts, never the text (§10). */
  private logHelp(
    request: HelpRequest,
    help: ReadAloudHelpSettings,
    label: { engine: string; model: string; effort: string },
    cache: 'hit' | 'miss',
    promptChars: number,
    outcome: { durationMs: number; error?: string },
  ): void {
    const parts = [
      'help',
      `req=${request.requestId}`,
      `engine=${label.engine}`,
      `model=${label.model || '(default)'}`,
      `effort=${label.effort}`,
      `context=${help.contextMode}`,
      `follow-up=${request.followUp ?? 'first'}`,
      `shape=${helpShapeFor(request.passage)}`,
      `passage=${request.passage.length}ch`,
      `enclosing=${request.enclosing.length}ch`,
      `mentions=${request.mentions.length}ch`,
      `previous=${request.previous?.length ?? 0}ch`,
      `sent=${promptChars}ch`,
      `cache=${cache}`,
      `dur=${outcome.durationMs}ms`,
    ];
    if (outcome.error) {
      parts.push(`error=${outcome.error}`);
    }
    readAloudLog(parts.join(' '));
  }

  // ----------------------------------------------------------------- config

  /**
   * Synchronous snapshot for the injected `data-config` attribute and every
   * `readAloudConfig` message. A Kokoro voice id is its own name, so nothing
   * is ever looked up over the network for it.
   */
  public buildInitialConfig(sourceUri?: vscode.Uri): ReadAloudConfigMessage {
    const settings = readReadAloudSettings();
    const label = engineLabel(helpEngineConfig(settings.help));
    const config: ReadAloudConfigMessage = {
      command: 'readAloudConfig',
      enabled: settings.enabled,
      clickToRead: settings.clickToRead,
      speed: settings.speed,
      volume: settings.volume,
      voiceName: settings.kokoroVoice,
      modelId: KOKORO_MODEL_ID,
      highlightTheme: settings.highlightTheme,
      font: settings.font,
      // The low-strain page (05 §4.3) and eye strain 2 (07 §15.2): these ride
      // in `data-config`, so the page is applied at script evaluation, before
      // <body> is parsed.
      globalTheme: settings.globalTheme,
      textSize: settings.textSize,
      wordMarker: settings.wordMarker,
      dimWhileReading: settings.dimWhileReading,
      panelAutoHide: settings.panelAutoHide,
      // Spawning a process is Node-only, so the button is hidden in the web
      // build the way every other Node-only path is (§1).
      helpAvailable: !this.deps.isWebBuild,
      helpEngine: label.engine,
      helpModel: label.model,
      helpEffort: label.effort,
      helpAutoPlay: settings.help.autoPlay,
      // Notes (12 §3, §14.3): the store and the engine are Node-only.
      notesAvailable: !this.deps.isWebBuild && settings.notes.enabled,
      notesDecoration: settings.notes.decoration,
      // Classroom (13 §14.3): the same reasons.
      classroomAvailable: !this.deps.isWebBuild && settings.classroom.enabled,
      // 13 §12.5 — the module marker, live like the other switches.
      classroomMarker: settings.classroom.marker,
      // Retell (15 §14.3): the same reasons as classroom.
      retellAvailable: !this.deps.isWebBuild && settings.retell.enabled,
      retellMarker: settings.retell.marker,
    };
    // A module preview learns what it shows (13 §12.2). A broadcast (no
    // `sourceUri`) leaves the field out, so the webview keeps its value.
    if (sourceUri && this.moduleConfigFor) {
      try {
        config.classroomModule = this.moduleConfigFor(sourceUri);
      } catch (error) {
        readAloudLog(`classroom: module config failed: ${String(error)}`);
        config.classroomModule = null;
      }
    }
    // An edition preview learns what it shows (15 §12.2), the same way.
    if (sourceUri && this.editionConfigFor) {
      try {
        config.retellEdition = this.editionConfigFor(sourceUri);
      } catch (error) {
        readAloudLog(`retell: edition config failed: ${String(error)}`);
        config.retellEdition = null;
      }
    }
    return config;
  }

  /** Posted after crossnote's `webviewFinishLoading` (contract §2 handshake). */
  public async sendConfig(sourceUri: vscode.Uri): Promise<void> {
    if (this.guardWebBuild()) {
      return;
    }
    try {
      const sink = await this.deps.getSinkFor(sourceUri);
      await sink.post(this.buildInitialConfig(sourceUri));
    } catch (error) {
      readAloudLog(`sendConfig failed: ${String(error)}`);
    }
    for (const listener of this.configListeners) {
      try {
        listener(sourceUri);
      } catch (error) {
        readAloudLog(`onConfigSent listener failed: ${String(error)}`);
      }
    }
  }

  /** Reacts to a change of any of the §4.1 settings; never touches the network (A-20). */
  public async onSettingsChanged(keys: ReadAloudSettingKey[]): Promise<void> {
    if (this.guardWebBuild()) {
      return;
    }
    try {
      const settings = readReadAloudSettings();
      if (keys.includes('readAloudCacheSizeMB')) {
        this.cache.setMaxBytes(settings.cacheSizeMB * BYTES_PER_MB);
      }
      if (keys.includes('readAloudEnabled')) {
        if (!settings.enabled) {
          this.cancelAll('read aloud disabled');
        }
        this.deps.refreshAllPreviews();
      }
      await this.deps.postToAll(this.buildInitialConfig());
    } catch (error) {
      readAloudLog(`onSettingsChanged failed: ${String(error)}`);
    }
  }

  private async broadcastConfig(): Promise<void> {
    try {
      await this.deps.postToAll(this.buildInitialConfig());
    } catch (error) {
      readAloudLog(`config broadcast failed: ${String(error)}`);
    }
  }

  // ------------------------------------------------------------------- jobs

  /**
   * F13 `readAloudSynthesize`. Resolves once the job is *accepted*; the job
   * itself runs on in the background. Supersedes any running job, posting its
   * single `cancelled` terminal error here (A-16).
   */
  public async synthesize(request: SynthesizeRequest): Promise<void> {
    if (this.guardWebBuild()) {
      return;
    }
    const sourceUri = normalizeUri(request.sourceUri);
    const previous = this.job;
    if (previous) {
      this.job = null;
      previous.abort.abort();
      readAloudLog(`tts cancelled req=${previous.requestId} reason=superseded`);
      void this.postCancelled(previous);
    }

    // The sink lookup awaits the workspace mutex — a real yield — so the job
    // is reserved *synchronously* (no await between reading `this.job` above
    // and the assignment below) behind a sink that resolves later. A cancel,
    // a preview switch or another synthesize arriving meanwhile finds and
    // aborts this job instead of racing past it (one in-flight job, spec §5;
    // contract §3.7).
    const sinkPromise = (async () =>
      this.deps.getSinkFor(vscode.Uri.parse(request.sourceUri)))();

    // F5: only letters, digits, whitespace and sentence punctuation are ever
    // sent. The webview's offset map is against `request.text`, so every
    // block keeps the map back to its slice of it and word spans are
    // re-expressed before they are posted (see stepChunks). Decision 5: the
    // blocks of a continuous read are sanitised and chunked one by one.
    const ranges = request.options.blocks ?? [
      { key: '', start: 0, end: request.text.length },
    ];
    const blocks: JobBlock[] = [];
    let rawChars = 0;
    let sentChars = 0;
    for (let i = 0; i < ranges.length; i++) {
      const range = ranges[i];
      const slice = request.text.slice(range.start, range.end);
      const speakable = sanitizeForSpeech(slice);
      rawChars += slice.length;
      sentChars += speakable.text.length;
      blocks.push({ index: i, key: range.key, start: range.start, speakable });
    }
    if (sentChars !== rawChars) {
      readAloudLog(
        `tts sanitised req=${request.requestId} ${rawChars} -> ${sentChars} chars`,
      );
    }

    const job: Job = {
      sourceUri,
      requestId: request.requestId,
      kind: request.options.kind,
      blocks,
      abort: new AbortController(),
      remaining: [],
      posted: 0,
      inFlight: false,
      playing: -1,
      wake: null,
      budget: { backoff: 3 },
      sink: {
        post: (message) => sinkPromise.then((sink) => sink.post(message)),
      },
    };
    this.job = job;

    try {
      await sinkPromise;
    } catch (error) {
      readAloudLog(`no preview for ${sourceUri}: ${String(error)}`);
      if (this.job === job) {
        this.job = null;
      }
      return;
    }
    if (job.abort.signal.aborted) {
      // Superseded, cancelled or torn down while the sink was resolving; the
      // aborter has already posted this job's single `cancelled` (A-16).
      return;
    }

    // F3: only one thing plays at a time across all preview panels.
    try {
      await this.deps.postToAll(
        { command: 'readAloudControl', action: 'stop' },
        sourceUri,
      );
    } catch (error) {
      readAloudLog(`stop broadcast failed: ${String(error)}`);
    }
    void this.run(job);
  }

  /** F13 `readAloudCancel`; a no-op for anything but the running job. */
  public cancel(request: CancelRequest): void {
    if (this.guardWebBuild()) {
      return;
    }
    const job = this.job;
    if (
      !job ||
      job.requestId !== request.requestId ||
      job.sourceUri !== normalizeUri(request.sourceUri)
    ) {
      return;
    }
    this.terminate(job, `webview (${request.reason ?? 'no reason given'})`);
  }

  /**
   * `readAloudPlaying`: the webview started chunk `chunkIndex` of the running
   * job, which advances the prefetch window (F11). A no-op for anything but
   * the running job.
   */
  public playing(request: PlayingRequest): void {
    if (this.deps.isWebBuild) {
      return;
    }
    const job = this.job;
    if (
      !job ||
      job.requestId !== request.requestId ||
      job.sourceUri !== normalizeUri(request.sourceUri)
    ) {
      return;
    }
    if (request.chunkIndex > job.playing) {
      job.playing = request.chunkIndex;
    }
    const wake = job.wake;
    if (wake) {
      wake();
    }
  }

  /** Panel closed, reloaded, or switched to another file (spec §6 Robustness). */
  public cancelForSource(sourceUri: string, reason: string): void {
    if (this.deps.isWebBuild) {
      return;
    }
    const helpJob = this.helpJob;
    if (helpJob && helpJob.sourceUri === normalizeUri(sourceUri)) {
      this.cancelHelp(reason);
    }
    const job = this.job;
    if (!job || job.sourceUri !== normalizeUri(sourceUri)) {
      return;
    }
    this.terminate(job, reason);
  }

  public cancelAll(reason: string): void {
    const job = this.job;
    if (!job) {
      return;
    }
    this.terminate(job, reason);
  }

  /**
   * G-12: a request the validators rejected still ends with exactly one
   * terminal event, so the webview's button never spins forever.
   */
  public async rejectSynthesize(args: unknown): Promise<void> {
    if (this.guardWebBuild()) {
      return;
    }
    if (
      !Array.isArray(args) ||
      typeof args[0] !== 'string' ||
      typeof args[1] !== 'string'
    ) {
      return;
    }
    try {
      const sink = await this.deps.getSinkFor(vscode.Uri.parse(args[0]));
      await sink.post({
        command: 'readAloudError',
        requestId: args[1],
        code: 'invalid_request',
        message: 'Read aloud request was rejected.',
        retryable: false,
      });
    } catch (error) {
      readAloudLog(`rejectSynthesize post failed: ${String(error)}`);
    }
  }

  public dispose(): void {
    this.cancelAll('deactivated');
    this.cancelHelp('deactivated');
    disposeReadAloudLog();
    if (instance === this) {
      instance = undefined;
    }
  }

  // ------------------------------------------------------------- job runner

  private terminate(job: Job, reason: string): void {
    this.job = null;
    job.abort.abort();
    readAloudLog(`tts cancelled req=${job.requestId} reason=${reason}`);
    void this.postCancelled(job);
  }

  private async postCancelled(job: Job): Promise<void> {
    try {
      await job.sink.post({
        command: 'readAloudError',
        requestId: job.requestId,
        code: CANCELLED_CODE,
        message: '',
        retryable: false,
      });
    } catch (error) {
      readAloudLog(`cancel post failed req=${job.requestId}: ${String(error)}`);
    }
  }

  /**
   * Plan, then synthesise and post the chunks, in one `try { for (;;) { try …
   * catch … } } finally` (G-14). The outer `finally` is the only place besides
   * the terminal points that clears `this.job`; a retry `continue`s into the
   * chunk loop with all closure state intact (A-37), resuming at the chunk
   * that failed.
   */
  private async run(job: Job): Promise<void> {
    const settings = readReadAloudSettings();
    const state: RunState = {
      planned: false,
      terminated: false,
      recovery: null,
      settings,
      client: this.makeKokoroClient(settings.kokoroBaseUrl),
      voiceId: settings.kokoroVoice || DEFAULT_KOKORO_VOICE,
      locale: vscode.env.language || 'en',
    };

    try {
      for (;;) {
        try {
          if (state.recovery) {
            const recovery = state.recovery;
            state.recovery = null;
            await this.recover(job, recovery);
          }
          if (job.abort.signal.aborted) {
            return;
          }
          if (!state.planned) {
            if ((await this.stepPlan(job, state)) === 'stop') {
              return;
            }
            state.planned = true;
          }
          await this.stepChunks(job, state);
          return;
        } catch (error) {
          if (state.terminated) {
            return;
          }
          const classified = this.classify(error);
          if (classified.kind === 'aborted') {
            return;
          }
          const verdict = await this.applyErrorAction(
            job,
            state,
            classified.info,
            classified.action,
          );
          if (verdict === 'retry') {
            continue;
          }
          return;
        }
      }
    } finally {
      if (this.job === job) {
        this.job = null;
      }
    }
  }

  /** The chunk plan (F11), block by block (decision 5). */
  private async stepPlan(job: Job, state: RunState): Promise<'ok' | 'stop'> {
    const plan = planReadChunks(
      job.blocks.map((block) => block.speakable.text),
      KOKORO_REQUEST_LIMIT_CHARS,
      state.locale,
    );
    job.remaining = plan.chunks.slice();
    if (job.remaining.length === 0) {
      await this.finishWithError(job, state, 'empty_text', '', false);
      return 'stop';
    }
    const chars = job.blocks.reduce(
      (sum, block) => sum + block.speakable.text.length,
      0,
    );
    readAloudLog(
      `tts plan req=${job.requestId} kind=${job.kind} blocks=${job.blocks.length} chunks=${job.remaining.length} chars=${chars}`,
    );
    return 'ok';
  }

  /** Synthesize and post the chunks, strictly one request at a time. */
  private async stepChunks(job: Job, state: RunState): Promise<void> {
    while (job.remaining.length > 0) {
      if (job.abort.signal.aborted) {
        return;
      }
      const chunk = job.remaining[0];
      const block = job.blocks[chunk.blockIndex];
      const key = cacheKey({
        text: chunk.text,
        voiceId: state.voiceId,
        modelId: KOKORO_MODEL_ID,
      });

      let audioBase64: string;
      let spans: WordSpan[] | null;
      let durationHint: number | undefined;
      let toCache: CacheEntry | null = null;

      const cached = this.cache.get(key);
      if (cached) {
        audioBase64 = cached.audioBase64;
        spans = cached.spans;
        // A hit posts a hint like a miss (14): the webview's timeline and
        // time display need every chunk's length, loaded or not.
        durationHint = cachedDurationHint(cached);
        this.logAttempt(job, state, chunk, 'hit');
      } else {
        await this.waitForPrefetchWindow(job, job.posted);
        if (job.abort.signal.aborted) {
          return;
        }
        if (job.inFlight) {
          throw new Error('read aloud: a request is already in flight');
        }
        job.inFlight = true;
        let synthesized: Synthesized;
        try {
          synthesized = await this.synthesizeChunk(job, state, chunk);
        } catch (error) {
          this.logAttempt(
            job,
            state,
            chunk,
            'miss',
            metaOfError(error),
            error instanceof Error ? error.message : String(error),
          );
          throw error;
        } finally {
          job.inFlight = false;
        }
        this.logAttempt(job, state, chunk, 'miss', synthesized.meta);
        audioBase64 = synthesized.audioBase64;
        spans = synthesized.spans;
        durationHint = synthesized.durationHint;
        toCache = {
          audioBase64,
          spans,
          mimeType: 'audio/mpeg',
          createdAt: Date.now(),
          ...(durationHint === undefined ? {} : { durationHint }),
        };
      }

      // Spans are cached relative to the chunk. Shift them into the block's
      // sanitised text, map them back into the block's slice of the text the
      // webview built its offset map from, then into the whole request text;
      // never in the cache.
      let shifted: WordSpan[] | null = null;
      if (spans !== null) {
        shifted = [];
        for (const span of spans) {
          const mapped = mapSpanBack(
            {
              ...span,
              charStart: span.charStart + chunk.charOffset,
              charEnd: span.charEnd + chunk.charOffset,
            },
            block.speakable.map,
          );
          if (mapped) {
            shifted.push({
              ...mapped,
              charStart: mapped.charStart + block.start,
              charEnd: mapped.charEnd + block.start,
            });
          }
        }
      }

      const isLast = job.remaining.length === 1;
      if (isLast) {
        // A-23/A-40: the final chunk is this job's terminal event.
        state.terminated = true;
        if (this.job === job) {
          this.job = null;
        }
      }
      await job.sink.post({
        command: 'readAloudAudio',
        requestId: job.requestId,
        chunkIndex: job.posted,
        chunkCount: job.posted + job.remaining.length,
        blockIndex: block.index,
        audioBase64,
        mimeType: 'audio/mpeg',
        spans: shifted,
        ...(durationHint === undefined ? {} : { durationHint }),
      });
      job.posted++;
      job.remaining.shift();
      // The disk write follows the post so the webview starts decoding while
      // the entry is written, not after.
      if (toCache) {
        this.cache.set(key, toCache);
      }
    }
  }

  /**
   * One Kokoro request for `chunk`; the server's per-token timestamps are
   * aligned to our words (`kokoro-alignment.ts`), interpolating any gap.
   */
  private async synthesizeChunk(
    job: Job,
    state: RunState,
    chunk: Chunk,
  ): Promise<Synthesized> {
    const result = await state.client.synthesize(
      { voice: state.voiceId, text: chunk.text },
      job.abort.signal,
    );
    let spans: WordSpan[] | null = null;
    let durationHint: number | undefined;
    if (result.words) {
      const aligned = alignKokoroWords(chunk.text, result.words, state.locale);
      if (aligned) {
        spans = aligned.spans;
        durationHint = aligned.audioEnd;
        if (aligned.matched < aligned.total) {
          readAloudLog(
            `kokoro alignment req=${job.requestId} chunk=${job.posted}: ${aligned.matched}/${aligned.total} words timed, the rest interpolated`,
          );
        }
      } else {
        readAloudLog(
          `kokoro timestamps do not match the sent text req=${job.requestId} chunk=${job.posted}: no word highlight`,
        );
      }
    } else {
      readAloudLog(
        `kokoro timestamps absent req=${job.requestId} chunk=${job.posted}: no word highlight`,
      );
    }
    return {
      audioBase64: result.audioBase64,
      spans,
      durationHint,
      meta: result.meta,
    };
  }

  /**
   * Hold the request for chunk `index` until it is within PREFETCH_CHUNKS of
   * the chunk the webview reports playing, or the job is aborted. Returns at
   * once when the chunk is already inside the window.
   */
  private async waitForPrefetchWindow(job: Job, index: number): Promise<void> {
    if (job.abort.signal.aborted || index <= job.playing + PREFETCH_CHUNKS) {
      return;
    }
    readAloudLog(
      `tts hold req=${job.requestId} chunk=${index + 1}/${
        job.posted + job.remaining.length
      } until chunk ${index - PREFETCH_CHUNKS + 1} plays`,
    );
    while (!job.abort.signal.aborted && index > job.playing + PREFETCH_CHUNKS) {
      await new Promise<void>((resolve) => {
        const signal = job.abort.signal;
        const onAbort = () => {
          job.wake = null;
          resolve();
        };
        job.wake = () => {
          signal.removeEventListener('abort', onAbort);
          job.wake = null;
          resolve();
        };
        signal.addEventListener('abort', onAbort, { once: true });
      });
    }
  }

  /**
   * The recovery half of a retry, executed inside the next iteration's `try`
   * so its own failures are classified like any other step error (G-13).
   */
  private async recover(job: Job, recovery: Recovery): Promise<void> {
    await sleep(recovery.delayMs, job.abort.signal);
  }

  /** The F10 table: either arm a retry, or post the single terminal error. */
  private async applyErrorAction(
    job: Job,
    state: RunState,
    info: ReadAloudErrorInfo,
    action: ErrorAction,
  ): Promise<'retry' | 'done'> {
    switch (action.kind) {
      case 'backoff': {
        if (job.budget.backoff > 0) {
          const index = Math.min(
            action.delaysMs.length - job.budget.backoff,
            action.delaysMs.length - 1,
          );
          job.budget.backoff--;
          state.recovery = {
            kind: 'backoff',
            delayMs: action.delaysMs[Math.max(0, index)],
          };
          return 'retry';
        }
        await this.finishWithError(
          job,
          state,
          info.code || 'rate_limit_exceeded',
          info.message,
          true,
        );
        return 'done';
      }
      case 'ignore':
        await this.finishWithError(
          job,
          state,
          info.code || 'empty_text',
          '',
          false,
        );
        return 'done';
      case 'serverError':
        await this.finishWithError(
          job,
          state,
          info.code || 'internal_error',
          userMessageFor(info, action),
          true,
        );
        return 'done';
      case 'network':
        await this.finishWithError(
          job,
          state,
          NETWORK_ERROR_CODE,
          userMessageFor(info, action),
          true,
        );
        return 'done';
      case 'unknown':
      default:
        await this.finishWithError(
          job,
          state,
          info.code || 'unknown_error',
          info.message,
          false,
        );
        return 'done';
    }
  }

  /** A-18 — the one place an unknown throwable becomes an {@link ErrorAction}. */
  private classify(error: unknown): Classified {
    if (error instanceof KokoroCancelledError) {
      return { kind: 'aborted' };
    }
    if (error instanceof KokoroHttpError) {
      const info = kokoroErrorInfo(error.status, error.detail);
      return { kind: 'error', info, action: mapKokoroErrorToAction(info) };
    }
    if (error instanceof KokoroNetworkError) {
      const info = kokoroErrorInfo(0, { message: error.message });
      return { kind: 'error', info, action: mapKokoroErrorToAction(info) };
    }
    const message = error instanceof Error ? error.message : String(error);
    return {
      kind: 'error',
      info: { status: 0, type: 'unknown', code: '', message },
      action: { kind: 'unknown' },
    };
  }

  /**
   * The one terminal `readAloudError` of a job (G-08). `terminated` is set and
   * `this.job` cleared *before* the post, so a cancel arriving mid-post is a
   * no-op and a throwing post cannot produce a second terminal (A-40).
   */
  private async finishWithError(
    job: Job,
    state: RunState,
    code: string,
    message: string,
    retryable: boolean,
  ): Promise<void> {
    state.terminated = true;
    if (this.job === job) {
      this.job = null;
    }
    if (job.abort.signal.aborted) {
      // The aborter (cancel, preview switch, supersede, dispose) has already
      // posted this job's single `cancelled`; a second terminal would break
      // G-08, so a failure that lands after it is only logged.
      readAloudLog(
        `tts failed req=${job.requestId} code=${code} chunk=${job.posted} suppressed: already cancelled`,
      );
      return;
    }
    readAloudLog(
      `tts failed req=${job.requestId} code=${code} retryable=${retryable} chunk=${job.posted}`,
    );
    try {
      await job.sink.post({
        command: 'readAloudError',
        requestId: job.requestId,
        code,
        message,
        retryable,
      });
    } catch (error) {
      readAloudLog(`error post failed req=${job.requestId}: ${String(error)}`);
    }
  }

  // ---------------------------------------------------------------- helpers

  private makeKokoroClient(baseUrl: string): KokoroClient {
    return new KokoroClient({
      baseUrl,
      timeoutMs: KOKORO_TIMEOUT_MS,
      log: (line) => readAloudLog(line),
    });
  }

  private logAttempt(
    job: Job,
    state: RunState,
    chunk: Chunk,
    cache: 'hit' | 'miss',
    meta?: ResponseMeta,
    error?: string,
  ): void {
    logRequest({
      kind: job.kind,
      requestId: job.requestId,
      chunk: `${job.posted + 1}/${job.posted + job.remaining.length}`,
      block: chunk.blockIndex,
      textLength: chunk.text.length,
      text: chunk.text,
      model: KOKORO_MODEL_ID,
      voice: state.voiceId,
      cache,
      meta,
      error,
    });
  }

  private reportCommandError(error: unknown): void {
    const classified = this.classify(error);
    if (classified.kind === 'aborted') {
      return;
    }
    readAloudLog(`command failed: ${classified.info.message}`);
    void vscode.window.showErrorMessage(
      userMessageFor(classified.info, classified.action),
    );
  }

  /** D2 — the feature is desktop-only in v1 (decision (g)). */
  private guardWebBuild(): boolean {
    if (!this.deps.isWebBuild) {
      return false;
    }
    if (!this.webNoticeShown) {
      this.webNoticeShown = true;
      void vscode.window.showInformationMessage(WEB_BUILD_MESSAGE);
    }
    return true;
  }
}
