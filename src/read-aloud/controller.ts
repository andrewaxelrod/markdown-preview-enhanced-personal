import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  CACHE_DIR_NAME,
  cacheKey,
  ReadAloudCache,
  type CacheEntry,
} from './cache';
import {
  contextTail,
  planChunks,
  replanFrom,
  type Chunk,
  type ChunkPlan,
} from './chunker';
import {
  ElevenLabsCancelledError,
  ElevenLabsClient,
  ElevenLabsHttpError,
  ElevenLabsNetworkError,
  type ResponseMeta,
} from './elevenlabs-client';
import {
  CANCELLED_CODE,
  kokoroErrorInfo,
  mapErrorToAction,
  mapKokoroErrorToAction,
  NETWORK_ERROR_CODE,
  parseElevenLabsError,
  TIMEOUT_MS,
  userMessageFor,
  type ElevenLabsErrorInfo,
  type ErrorAction,
} from './error-mapping';
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
} from './kokoro-client';
import { chooseKokoroVoiceQuickPick } from './kokoro-voices';
import {
  disposeReadAloudLog,
  logRequest,
  readAloudLog,
  showReadAloudLog,
} from './log';
import type {
  HostToWebviewMessage,
  PlayingRequest,
  ReadAloudConfigMessage,
  ReadAloudControlAction,
  ReadAloudKind,
  SynthesizeOptions,
  SynthesizeRequest,
} from './messages';
import {
  DEFAULT_MODEL_ID,
  findModel,
  isFreeSubscription,
  limitFromModel,
  MODEL_IDS,
  type ModelLimits,
} from './models';
import {
  clearElevenLabsApiKey,
  getElevenLabsApiKey,
  promptForElevenLabsApiKey,
  setReadAloudSecretsContext,
  storeElevenLabsApiKey,
} from './secrets';
import {
  DEFAULT_READ_ALOUD_PROVIDER,
  readReadAloudSettings,
  writeModelIdSetting,
  writeSpeedSetting,
  writeVoiceIdSetting,
  type ReadAloudProvider,
  type ReadAloudSettingKey,
  type ReadAloudSettings,
} from './settings';
import { appendSentText, sentLogPath } from './sent-log';
import { mapSpanBack, sanitizeForSpeech } from './speakable';
import {
  chooseVoiceQuickPick,
  getCachedVoiceName,
  resolveDefaultVoice,
  setVoicesContext,
  validateVoice,
  type ResolvedVoice,
} from './voices';
import { toWordSpans, type WordSpan } from './word-spans';

/**
 * The host-side read-aloud state machine (F7–F13, contract §3.7).
 *
 * One job at a time, one request in flight at a time, by construction: a new
 * `readAloudSynthesize` supersedes the running job, and every job ends with
 * exactly one terminal event — the last `readAloudAudio` or a single
 * `readAloudError`.
 */

const WEB_BUILD_MESSAGE =
  'Read aloud is not available in VS Code for the Web (v1).';
const OPEN_ELEVENLABS_ACTION = 'Open elevenlabs.io';
const SUBSCRIPTION_URL = 'https://elevenlabs.io/app/subscription';
const CONFIRM_READ_ACTION = 'Read aloud';
const SETUP_SET_KEY = 'Set ElevenLabs API Key';
const SETUP_CHOOSE_VOICE = 'Choose Read Aloud Voice';
const SETUP_SHOW_LOG = 'Show Read Aloud Log';
const SETUP_CHECK_KOKORO = 'Check Kokoro Server';
const BYTES_PER_MB = 1048576;

/**
 * Lazy synthesis (F11): a billable request for chunk *k* is held until the
 * webview reports chunk *k − LOOKAHEAD_CHUNKS* playing. With the chunker's
 * ~45 s chunks one chunk of lookahead hides the request latency, and a stop
 * or pause never pays for more than one chunk beyond the audio heard. Cache
 * hits are never held: they cost nothing.
 */
const LOOKAHEAD_CHUNKS = 1;

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
}

interface Job {
  sourceUri: string;
  requestId: string;
  kind: ReadAloudKind;
  /** The speakable text (`sanitizeForSpeech`), not what the webview sent. */
  text: string;
  /** Offsets of `text` back into the webview's text (`SpeakableText.map`). */
  map: number[];
  /** Context already sanitised the same way. */
  options: SynthesizeOptions;
  /** Base directory of the sent-text log (`logs/read-aloud-sent.log`). */
  logDir: string;
  abort: AbortController;
  plan: ChunkPlan | null;
  remaining: Chunk[];
  posted: number;
  inFlight: boolean;
  /** Highest chunk index the webview has reported playing; −1 before the first. */
  playing: number;
  /** Resolves the pending {@link waitForPlayback}, if any. */
  wake: (() => void) | null;
  budget: {
    backoff: number;
    voice: number;
    model: number;
    rechunk: number;
    key: number;
  };
  sink: PreviewSink;
}

type RunStep = 'key' | 'voice' | 'limits' | 'plan' | 'guard' | 'chunks';

type Recovery =
  | { kind: 'promptKey' }
  | { kind: 'reresolveVoice' }
  | { kind: 'resetModel' }
  | { kind: 'backoff'; delayMs: number }
  | { kind: 'rechunk' };

/** Closure-local state of one `run(job)` (A-16): never reachable from `this`. */
interface RunState {
  step: RunStep;
  terminated: boolean;
  recovery: Recovery | null;
  settings: ReadAloudSettings;
  provider: ReadAloudProvider;
  client: ElevenLabsClient | null;
  kokoroClient: KokoroClient | null;
  voice: ResolvedVoice | null;
  modelId: string;
  modelMaxChars: number;
  limit: number;
  locale: string;
  lastPostedText: string | null;
  failedOffset: number;
}

type Classified =
  | { kind: 'aborted' }
  | { kind: 'error'; info: ElevenLabsErrorInfo; action: ErrorAction };

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

function parseCost(raw: string | null): number | null {
  if (raw === null || raw.trim().length === 0) {
    return null;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

/** What one provider request yields for one chunk, before caching and posting. */
interface Synthesized {
  audioBase64: string;
  spans: WordSpan[] | null;
  durationHint: number | undefined;
  meta: ResponseMeta;
}

function metaOfError(error: unknown): ResponseMeta | undefined {
  if (
    error instanceof ElevenLabsHttpError ||
    error instanceof KokoroHttpError
  ) {
    return error.meta;
  }
  return undefined;
}

function maxOf(values: number[]): number | undefined {
  let max: number | undefined;
  for (const value of values) {
    if (Number.isFinite(value) && (max === undefined || value > max)) {
      max = value;
    }
  }
  return max;
}

let instance: ReadAloudController | undefined;

export class ReadAloudController implements vscode.Disposable {
  private readonly deps: ControllerDeps;
  private readonly cache: ReadAloudCache;
  private readonly globalStorageDir: string;
  private readonly modelLimits = new Map<string, ModelLimits>();
  private readonly validatedVoices = new Set<string>();
  private readonly announcedLogDirs = new Set<string>();
  private modelLimitsPromise: Promise<void> | null = null;
  private webNoticeShown = false;
  private job: Job | null = null;

  private constructor(context: vscode.ExtensionContext, deps: ControllerDeps) {
    this.deps = deps;
    this.globalStorageDir = context.globalStorageUri.fsPath;
    const dir = path.join(context.globalStorageUri.fsPath, CACHE_DIR_NAME);
    this.cache = new ReadAloudCache(
      dir,
      readReadAloudSettings().cacheSizeMB * BYTES_PER_MB,
    );
  }

  /** Idempotent; also wires the secrets and voice-name caches to the context. */
  public static init(
    context: vscode.ExtensionContext,
    deps: ControllerDeps,
  ): ReadAloudController {
    if (!instance) {
      setReadAloudSecretsContext(context);
      setVoicesContext(context);
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

  /** F7 — prompt, validate with `GET /v1/user/subscription`, then store. */
  public async setApiKeyCommand(): Promise<void> {
    if (this.guardWebBuild()) {
      return;
    }
    try {
      const entered = await promptForElevenLabsApiKey();
      if (!entered) {
        return;
      }
      const settings = readReadAloudSettings();
      const probe = this.makeClient(settings.baseUrl, entered);
      const subscription = await probe.getSubscription();
      await storeElevenLabsApiKey(entered);
      const remaining = Math.max(
        0,
        subscription.characterLimit - subscription.characterCount,
      );
      void vscode.window.showInformationMessage(
        `ElevenLabs key saved. Tier: ${subscription.tier}, ${remaining} characters left this period.`,
      );
    } catch (error) {
      // F7: the previous key is kept and the mapped error is shown.
      this.reportCommandError(error, false);
    }
  }

  public async clearApiKeyCommand(): Promise<void> {
    if (this.guardWebBuild()) {
      return;
    }
    try {
      await clearElevenLabsApiKey();
      void vscode.window.showInformationMessage('ElevenLabs API key cleared.');
    } catch (error) {
      this.reportCommandError(error, false);
    }
  }

  /** F8 — the `Choose Read Aloud Voice` QuickPick. */
  public async chooseVoiceCommand(): Promise<void> {
    if (this.guardWebBuild()) {
      return;
    }
    try {
      const settings = readReadAloudSettings();
      if (settings.provider === 'kokoro') {
        const picked = await chooseKokoroVoiceQuickPick(
          this.makeKokoroClient(settings.kokoroBaseUrl),
        );
        if (!picked) {
          return;
        }
        await this.broadcastConfig();
        return;
      }
      let key = await getElevenLabsApiKey();
      if (!key) {
        await this.setApiKeyCommand();
        key = await getElevenLabsApiKey();
        if (!key) {
          return;
        }
      }
      const picked = await chooseVoiceQuickPick(
        this.makeClient(settings.baseUrl, key),
      );
      if (!picked) {
        return;
      }
      await this.broadcastConfig();
    } catch (error) {
      this.reportCommandError(error, true);
    }
  }

  /** F12 — the `Clear Read Aloud Cache` command. */
  public async clearCacheCommand(): Promise<void> {
    if (this.guardWebBuild()) {
      return;
    }
    try {
      const removed = this.cache.clear();
      void vscode.window.showInformationMessage(
        `Read aloud cache cleared (${removed} entries).`,
      );
    } catch (error) {
      this.reportCommandError(error, true);
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
      const items =
        settings.provider === 'kokoro'
          ? [SETUP_CHECK_KOKORO, SETUP_CHOOSE_VOICE, SETUP_SHOW_LOG]
          : [SETUP_SET_KEY, SETUP_CHOOSE_VOICE, SETUP_SHOW_LOG];
      const picked = await vscode.window.showQuickPick(items, {
        placeHolder: `Read aloud setup (${settings.provider})`,
      });
      if (picked === SETUP_SET_KEY) {
        await this.setApiKeyCommand();
      } else if (picked === SETUP_CHECK_KOKORO) {
        await this.checkKokoroServer(settings.kokoroBaseUrl);
      } else if (picked === SETUP_CHOOSE_VOICE) {
        await this.chooseVoiceCommand();
      } else if (picked === SETUP_SHOW_LOG) {
        showReadAloudLog();
      }
    } catch (error) {
      this.reportCommandError(error, true);
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
  public async control(action: ReadAloudControlAction): Promise<void> {
    if (this.guardWebBuild()) {
      return;
    }
    try {
      await this.deps.postToAll({ command: 'readAloudControl', action });
    } catch (error) {
      readAloudLog(`control ${action} failed: ${String(error)}`);
    }
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

  // ----------------------------------------------------------------- config

  /** Synchronous snapshot for the injected `data-config` attribute. */
  public buildInitialConfig(): ReadAloudConfigMessage {
    const settings = readReadAloudSettings();
    const kokoro = settings.provider === 'kokoro';
    return {
      command: 'readAloudConfig',
      enabled: settings.enabled,
      clickToRead: settings.clickToRead,
      speed: settings.speed,
      voiceName: kokoro
        ? settings.kokoroVoice
        : (settings.voiceId && getCachedVoiceName(settings.voiceId)) || '',
      modelId: kokoro ? KOKORO_MODEL_ID : settings.modelId,
      highlightTheme: settings.highlightTheme,
    };
  }

  /**
   * Same, but resolving the voice name when it is not cached yet — at most one
   * `GET /v1/voices/{id}` per voice id per session, and only when a key is
   * stored (A-14). Never prompts, never rejects.
   */
  public async buildConfigMessage(): Promise<ReadAloudConfigMessage> {
    const message = this.buildInitialConfig();
    const settings = readReadAloudSettings();
    if (settings.provider === 'kokoro') {
      // A Kokoro voice id is its own name: nothing to look up.
      return message;
    }
    if (!settings.voiceId || message.voiceName) {
      return message;
    }
    if (this.validatedVoices.has(settings.voiceId)) {
      return message;
    }
    try {
      const key = await getElevenLabsApiKey();
      if (!key) {
        return message;
      }
      this.validatedVoices.add(settings.voiceId);
      const voice = await validateVoice(
        this.makeClient(settings.baseUrl, key),
        settings.voiceId,
      );
      if (voice) {
        message.voiceName = voice.name;
      }
    } catch (error) {
      readAloudLog(`voice name lookup failed: ${String(error)}`);
    }
    return message;
  }

  /** Posted after crossnote's `webviewFinishLoading` (contract §2 handshake). */
  public async sendConfig(sourceUri: vscode.Uri): Promise<void> {
    if (this.guardWebBuild()) {
      return;
    }
    try {
      const sink = await this.deps.getSinkFor(sourceUri);
      await sink.post(await this.buildConfigMessage());
    } catch (error) {
      readAloudLog(`sendConfig failed: ${String(error)}`);
    }
  }

  /** Reacts to a change of any of the eight §4.1 settings. */
  public async onSettingsChanged(keys: ReadAloudSettingKey[]): Promise<void> {
    if (this.guardWebBuild()) {
      return;
    }
    try {
      const settings = readReadAloudSettings();
      if (keys.includes('readAloudCacheSizeMB')) {
        this.cache.setMaxBytes(settings.cacheSizeMB * BYTES_PER_MB);
      }
      if (keys.includes('elevenLabsVoiceId')) {
        this.validatedVoices.delete(settings.voiceId);
      }
      if (keys.includes('readAloudEnabled')) {
        if (!settings.enabled) {
          this.cancelAll('read aloud disabled');
        }
        this.deps.refreshAllPreviews();
      }
      // A speed, highlight theme or click-to-read change must never touch the
      // network (A-20).
      const localOnly = keys.every(
        (key) =>
          key === 'readAloudSpeed' ||
          key === 'readAloudHighlightTheme' ||
          key === 'readAloudClickToRead',
      );
      const message = localOnly
        ? this.buildInitialConfig()
        : await this.buildConfigMessage();
      await this.deps.postToAll(message);
    } catch (error) {
      readAloudLog(`onSettingsChanged failed: ${String(error)}`);
    }
  }

  private async broadcastConfig(): Promise<void> {
    try {
      await this.deps.postToAll(await this.buildConfigMessage());
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
    // aborts this job instead of racing past it (one in-flight job, spec §5
    // and §6 Cost; contract §3.7).
    const sinkPromise = (async () =>
      this.deps.getSinkFor(vscode.Uri.parse(request.sourceUri)))();

    // F5: only letters, digits, whitespace and sentence punctuation are ever
    // sent. The webview's offset map is against `request.text`, so the job
    // keeps the map back to it and word spans are re-expressed before they
    // are posted (see stepChunks).
    const speakable = sanitizeForSpeech(request.text);
    if (speakable.text.length !== request.text.length) {
      readAloudLog(
        `tts sanitised req=${request.requestId} ${request.text.length} -> ${speakable.text.length} chars`,
      );
    }
    const options: SynthesizeOptions = { kind: request.options.kind };
    if (request.options.blockId !== undefined) {
      options.blockId = request.options.blockId;
    }
    const previousText = sanitizeForSpeech(
      request.options.previousText ?? '',
    ).text;
    if (previousText) {
      options.previousText = previousText;
    }
    const nextText = sanitizeForSpeech(request.options.nextText ?? '').text;
    if (nextText) {
      options.nextText = nextText;
    }

    const job: Job = {
      sourceUri,
      requestId: request.requestId,
      kind: request.options.kind,
      text: speakable.text,
      map: speakable.map,
      options,
      logDir: this.sentLogDirFor(request.sourceUri),
      abort: new AbortController(),
      plan: null,
      remaining: [],
      posted: 0,
      inFlight: false,
      playing: -1,
      wake: null,
      budget: { backoff: 3, voice: 1, model: 1, rechunk: 3, key: 1 },
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
  public cancel(request: { sourceUri: string; requestId: string }): void {
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
    this.terminate(job, 'webview');
  }

  /**
   * `readAloudPlaying`: the webview started chunk `chunkIndex` of the running
   * job, which releases the held request for the next chunk (F11 lazy
   * synthesis). A no-op for anything but the running job.
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
   * Steps 1–6 of contract §3.7, in one `try { for (;;) { try … catch … } }
   * finally` (G-14). The outer `finally` is the only place besides the terminal
   * points that clears `this.job`; a retry `continue`s into the step that threw
   * with all closure state intact (A-37).
   */
  private async run(job: Job): Promise<void> {
    const state: RunState = {
      step: 'key',
      terminated: false,
      recovery: null,
      settings: readReadAloudSettings(),
      provider: DEFAULT_READ_ALOUD_PROVIDER,
      client: null,
      kokoroClient: null,
      voice: null,
      modelId: DEFAULT_MODEL_ID,
      modelMaxChars: 0,
      limit: 0,
      locale: vscode.env.language || 'en',
      lastPostedText: null,
      failedOffset: 0,
    };
    state.provider = state.settings.provider;
    state.modelId =
      state.provider === 'kokoro' ? KOKORO_MODEL_ID : state.settings.modelId;

    try {
      for (;;) {
        try {
          if (state.recovery) {
            const recovery = state.recovery;
            state.recovery = null;
            if ((await this.recover(job, state, recovery)) === 'stop') {
              return;
            }
          }
          if (job.abort.signal.aborted) {
            return;
          }
          if (state.step === 'key') {
            if ((await this.stepKey(job, state)) === 'stop') {
              return;
            }
            state.step = 'voice';
          }
          if (state.step === 'voice') {
            if ((await this.stepVoice(job, state)) === 'stop') {
              return;
            }
            state.step = 'limits';
          }
          if (state.step === 'limits') {
            this.stepLimits(state);
            state.step = 'plan';
          }
          if (state.step === 'plan') {
            if ((await this.stepPlan(job, state)) === 'stop') {
              return;
            }
            state.step = 'guard';
          }
          if (state.step === 'guard') {
            if ((await this.stepCostGuard(job, state)) === 'stop') {
              return;
            }
            state.step = 'chunks';
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

  /** Step 1: the API key, prompting and validating it when there is none (F7). */
  private async stepKey(job: Job, state: RunState): Promise<'ok' | 'stop'> {
    if (state.provider === 'kokoro') {
      // No key and no account: the local server is the whole setup.
      state.kokoroClient = this.makeKokoroClient(state.settings.kokoroBaseUrl);
      return 'ok';
    }
    let key = await getElevenLabsApiKey();
    if (!key) {
      const entered = await promptForElevenLabsApiKey();
      if (!entered) {
        await this.finishWithError(
          job,
          state,
          'missing_api_key',
          'ElevenLabs API key not set.',
          true,
        );
        return 'stop';
      }
      // A-39: step 1 owns its validation failure; it never re-enters classify,
      // so a bad key here can never open a second prompt.
      try {
        const probe = this.makeClient(state.settings.baseUrl, entered);
        const subscription = await probe.getSubscription(job.abort.signal);
        await storeElevenLabsApiKey(entered);
        const remaining = Math.max(
          0,
          subscription.characterLimit - subscription.characterCount,
        );
        void vscode.window.showInformationMessage(
          `ElevenLabs key saved. Tier: ${subscription.tier}, ${remaining} characters left this period.`,
        );
        key = entered;
      } catch (error) {
        if (error instanceof ElevenLabsCancelledError) {
          return 'stop';
        }
        if (error instanceof ElevenLabsNetworkError) {
          readAloudLog(`key validation failed: ${error.message}`);
          await this.finishWithError(
            job,
            state,
            NETWORK_ERROR_CODE,
            'Could not reach ElevenLabs.',
            true,
          );
          return 'stop';
        }
        const info =
          error instanceof ElevenLabsHttpError
            ? error.info
            : parseElevenLabsError(
                0,
                undefined,
                error instanceof Error ? error.message : String(error),
              );
        const action = mapErrorToAction(info);
        void vscode.window.showErrorMessage(userMessageFor(info, action));
        const authFailure =
          action.kind === 'promptApiKey' ||
          info.status === 401 ||
          info.status === 403;
        await this.finishWithError(
          job,
          state,
          authFailure ? 'invalid_api_key' : info.code || 'invalid_api_key',
          authFailure
            ? userMessageFor(info, { kind: 'promptApiKey' })
            : userMessageFor(info, action),
          true,
        );
        return 'stop';
      }
    }
    state.client = this.makeClient(state.settings.baseUrl, key);
    return 'ok';
  }

  /** Step 2: the voice, resolved at runtime when the setting is empty (F8). */
  private async stepVoice(job: Job, state: RunState): Promise<'ok' | 'stop'> {
    if (state.voice) {
      return 'ok';
    }
    if (state.provider === 'kokoro') {
      const voiceId = state.settings.kokoroVoice || DEFAULT_KOKORO_VOICE;
      state.voice = { voiceId, name: voiceId };
      return 'ok';
    }
    if (state.settings.voiceId) {
      state.voice = {
        voiceId: state.settings.voiceId,
        name: getCachedVoiceName(state.settings.voiceId) ?? '',
      };
      return 'ok';
    }
    const voice = await resolveDefaultVoice(
      this.requireClient(state),
      job.abort.signal,
    );
    if (!voice) {
      // A-30: `resolveDefaultVoice` has already shown the only notification.
      await this.finishWithError(
        job,
        state,
        'voice_not_found',
        'No ElevenLabs voice is available on this account.',
        false,
      );
      return 'stop';
    }
    state.voice = voice;
    return 'ok';
  }

  /** Step 3: per-model limits, from the session cache or the R2 §8.1 fallbacks. */
  private stepLimits(state: RunState): void {
    if (state.provider === 'kokoro') {
      state.modelMaxChars = KOKORO_REQUEST_LIMIT_CHARS;
      return;
    }
    state.modelMaxChars = this.peekModelLimits(state.modelId).maxChars;
    // Background refresh; no pre-flight call on the play path (§5 Latency).
    void this.loadModelLimits(this.requireClient(state));
  }

  /** Step 4: the chunk plan (F11). */
  private async stepPlan(job: Job, state: RunState): Promise<'ok' | 'stop'> {
    const plan = planChunks(job.text, state.modelMaxChars, state.locale, {
      previousText: job.options.previousText,
      nextText: job.options.nextText,
    });
    job.plan = plan;
    job.remaining = plan.chunks.slice();
    state.limit = plan.limit;
    if (job.remaining.length === 0) {
      await this.finishWithError(job, state, 'empty_text', '', false);
      return 'stop';
    }
    return 'ok';
  }

  /** Step 5: the F11 cost guard, before any billable request (B18). */
  private async stepCostGuard(
    job: Job,
    state: RunState,
  ): Promise<'ok' | 'stop'> {
    if (state.provider === 'kokoro') {
      // Nothing is billed and nothing leaves this machine.
      return 'ok';
    }
    if (job.text.length <= state.settings.confirmAbove) {
      return 'ok';
    }
    let remaining: number | undefined;
    try {
      const subscription = await this.requireClient(state).getSubscription(
        job.abort.signal,
      );
      remaining = Math.max(
        0,
        subscription.characterLimit - subscription.characterCount,
      );
    } catch (error) {
      if (error instanceof ElevenLabsCancelledError) {
        throw error;
      }
      readAloudLog(`quota lookup failed: ${String(error)}`);
    }
    const picked = await vscode.window.showWarningMessage(
      `Read aloud will send ${job.text.length} characters to ElevenLabs (${
        remaining === undefined ? 'unknown' : remaining
      } remaining this period). Continue?`,
      { modal: true },
      CONFIRM_READ_ACTION,
    );
    if (picked !== CONFIRM_READ_ACTION) {
      await this.finishWithError(job, state, CANCELLED_CODE, '', false);
      return 'stop';
    }
    return 'ok';
  }

  /** Step 6: synthesize and post the chunks, strictly one request at a time. */
  private async stepChunks(job: Job, state: RunState): Promise<void> {
    const voice = state.voice ?? { voiceId: '', name: '' };
    while (job.remaining.length > 0) {
      if (job.abort.signal.aborted) {
        return;
      }
      const chunk = job.remaining[0];
      state.failedOffset = chunk.charOffset;
      const key = cacheKey({
        text: chunk.text,
        voiceId: voice.voiceId,
        modelId: state.modelId,
      });

      let audioBase64: string;
      let spans: WordSpan[] | null;
      let durationHint: number | undefined;
      let toCache: CacheEntry | null = null;

      const cached = this.cache.get(key);
      if (cached) {
        audioBase64 = cached.audioBase64;
        spans = cached.spans;
        this.logAttempt(job, state, chunk, 'hit');
      } else {
        await this.waitForPlayback(job, job.posted);
        if (job.abort.signal.aborted) {
          return;
        }
        if (job.inFlight) {
          throw new Error('read aloud: a request is already in flight');
        }
        job.inFlight = true;
        let synthesized: Synthesized;
        // The plain record of what goes out: exactly this string, one line.
        void appendSentText(job.logDir, chunk.text);
        try {
          synthesized =
            state.provider === 'kokoro'
              ? await this.synthesizeWithKokoro(
                  job,
                  state,
                  chunk,
                  voice.voiceId,
                )
              : await this.synthesizeWithElevenLabs(
                  job,
                  state,
                  chunk,
                  voice.voiceId,
                );
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
          characterCost: parseCost(synthesized.meta.characterCost),
          createdAt: Date.now(),
        };
      }

      // Spans are cached relative to the chunk. Shift them into the sanitised
      // text, then map them back into the text the webview built its offset
      // map from; never in the cache.
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
            job.map,
          );
          if (mapped) {
            shifted.push(mapped);
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
        audioBase64,
        mimeType: 'audio/mpeg',
        spans: shifted,
        ...(durationHint === undefined ? {} : { durationHint }),
      });
      job.posted++;
      state.lastPostedText = chunk.text;
      job.remaining.shift();
      // The disk write follows the post so the webview starts decoding while
      // the entry is written, not after.
      if (toCache) {
        this.cache.set(key, toCache);
      }
    }
  }

  /**
   * One ElevenLabs request for `chunk`; its per-character alignment becomes
   * word spans (F4), or `null` spans with a log line when it cannot.
   */
  private async synthesizeWithElevenLabs(
    job: Job,
    state: RunState,
    chunk: Chunk,
    voiceId: string,
  ): Promise<Synthesized> {
    const result = await this.requireClient(state).synthesizeWithTimestamps(
      {
        voiceId,
        modelId: state.modelId,
        text: chunk.text,
        previousText: chunk.previousText,
        nextText: chunk.nextText,
      },
      job.abort.signal,
    );
    let spans: WordSpan[] | null = null;
    let durationHint: number | undefined;
    if (result.alignment) {
      const computed = toWordSpans(chunk.text, result.alignment, state.locale);
      if (computed) {
        spans = computed;
        durationHint = maxOf(result.alignment.characterEndTimesSeconds);
      } else {
        readAloudLog(
          `alignment does not reproduce the sent text req=${job.requestId} chunk=${job.posted}: no word highlight`,
        );
      }
    } else {
      readAloudLog(
        `alignment absent req=${job.requestId} chunk=${job.posted}: no word highlight`,
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
   * One Kokoro request for `chunk`; the server's per-token timestamps are
   * aligned to our words (`kokoro-alignment.ts`), interpolating any gap.
   */
  private async synthesizeWithKokoro(
    job: Job,
    state: RunState,
    chunk: Chunk,
    voiceId: string,
  ): Promise<Synthesized> {
    const result = await this.requireKokoroClient(state).synthesize(
      { voice: voiceId, text: chunk.text },
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
   * Hold a billable request for chunk `index` until the webview has reported
   * chunk `index − LOOKAHEAD_CHUNKS` playing, or the job is aborted. Returns
   * at once when the chunk is already within the lookahead.
   */
  private async waitForPlayback(job: Job, index: number): Promise<void> {
    if (job.abort.signal.aborted || index <= job.playing + LOOKAHEAD_CHUNKS) {
      return;
    }
    readAloudLog(
      `tts hold req=${job.requestId} chunk=${index + 1}/${
        job.posted + job.remaining.length
      } until chunk ${index - LOOKAHEAD_CHUNKS + 1} plays`,
    );
    while (
      !job.abort.signal.aborted &&
      index > job.playing + LOOKAHEAD_CHUNKS
    ) {
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
  private async recover(
    job: Job,
    state: RunState,
    recovery: Recovery,
  ): Promise<'continue' | 'stop'> {
    switch (recovery.kind) {
      case 'promptKey': {
        const entered = await promptForElevenLabsApiKey();
        if (!entered) {
          await this.finishWithError(
            job,
            state,
            'missing_api_key',
            'ElevenLabs API key not set.',
            true,
          );
          return 'stop';
        }
        const probe = this.makeClient(state.settings.baseUrl, entered);
        await probe.getSubscription(job.abort.signal);
        await storeElevenLabsApiKey(entered);
        state.client = this.makeClient(state.settings.baseUrl, entered);
        return 'continue';
      }
      case 'reresolveVoice': {
        await writeVoiceIdSetting('');
        state.settings = { ...state.settings, voiceId: '' };
        state.voice = null;
        const voice = await resolveDefaultVoice(
          this.requireClient(state),
          job.abort.signal,
        );
        if (!voice) {
          await this.finishWithError(
            job,
            state,
            'voice_not_found',
            'No ElevenLabs voice is available on this account.',
            false,
          );
          return 'stop';
        }
        state.voice = voice;
        return 'continue';
      }
      case 'resetModel': {
        await writeModelIdSetting(DEFAULT_MODEL_ID);
        state.modelId = DEFAULT_MODEL_ID;
        state.settings = { ...state.settings, modelId: DEFAULT_MODEL_ID };
        return 'continue';
      }
      case 'backoff': {
        await sleep(recovery.delayMs, job.abort.signal);
        return 'continue';
      }
      case 'rechunk':
      default: {
        state.limit = Math.max(1, Math.floor(state.limit / 2));
        job.remaining = replanFrom(
          job.text,
          state.failedOffset,
          state.limit,
          state.locale,
          {
            previousText:
              state.lastPostedText === null
                ? job.options.previousText
                : contextTail(state.lastPostedText),
            nextText: job.options.nextText,
          },
        );
        if (job.remaining.length === 0) {
          await this.finishWithError(
            job,
            state,
            'text_too_long',
            'Text too long for one request; splitting.',
            false,
          );
          return 'stop';
        }
        return 'continue';
      }
    }
  }

  /** The §3.5 table: either arm a retry, or post the single terminal error. */
  private async applyErrorAction(
    job: Job,
    state: RunState,
    info: ElevenLabsErrorInfo,
    action: ErrorAction,
  ): Promise<'retry' | 'done'> {
    switch (action.kind) {
      case 'promptApiKey':
        if (job.budget.key > 0) {
          job.budget.key--;
          state.recovery = { kind: 'promptKey' };
          return 'retry';
        }
        await this.finishWithError(
          job,
          state,
          info.code || 'invalid_api_key',
          userMessageFor(info, action),
          true,
        );
        return 'done';
      case 'reresolveVoice':
        if (job.budget.voice > 0) {
          job.budget.voice--;
          state.recovery = { kind: 'reresolveVoice' };
          return 'retry';
        }
        await this.finishWithError(
          job,
          state,
          info.code || 'voice_not_found',
          userMessageFor(info, action),
          false,
        );
        return 'done';
      case 'resetModel':
        if (job.budget.model > 0) {
          job.budget.model--;
          state.recovery = { kind: 'resetModel' };
          return 'retry';
        }
        await this.finishWithError(
          job,
          state,
          info.code || 'model_not_found',
          userMessageFor(info, action),
          false,
        );
        return 'done';
      case 'rechunk':
        if (job.budget.rechunk > 0 && job.remaining.length > 0) {
          job.budget.rechunk--;
          state.recovery = { kind: 'rechunk' };
          return 'retry';
        }
        await this.finishWithError(
          job,
          state,
          'text_too_long',
          userMessageFor(info, action),
          false,
        );
        return 'done';
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
      case 'quota': {
        const quota = await this.readQuota(state, job.abort.signal);
        if (job.abort.signal.aborted) {
          // Cancelled during the lookup: the aborter has posted this job's
          // single `cancelled`, so neither the notification nor a second
          // terminal follows (G-08, A-16).
          state.terminated = true;
          return 'done';
        }
        const message = userMessageFor(info, action, quota);
        void vscode.window
          .showWarningMessage(message, OPEN_ELEVENLABS_ACTION)
          .then(
            (picked) => {
              if (picked === OPEN_ELEVENLABS_ACTION) {
                void vscode.env
                  .openExternal(vscode.Uri.parse(SUBSCRIPTION_URL))
                  .then(undefined, () => {
                    readAloudLog('could not open elevenlabs.io');
                  });
              }
            },
            () => {
              // A dismissed notification is not an error.
            },
          );
        await this.finishWithError(
          job,
          state,
          'insufficient_credits',
          message,
          false,
        );
        return 'done';
      }
      case 'showVerbatim':
        void vscode.window.showErrorMessage(info.message);
        await this.finishWithError(
          job,
          state,
          info.code || 'feature_not_available',
          info.message,
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
    if (
      error instanceof ElevenLabsCancelledError ||
      error instanceof KokoroCancelledError
    ) {
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
    if (error instanceof ElevenLabsHttpError) {
      return {
        kind: 'error',
        info: error.info,
        action: mapErrorToAction(error.info),
      };
    }
    if (error instanceof ElevenLabsNetworkError) {
      const info: ElevenLabsErrorInfo = {
        status: 0,
        type: 'network',
        code: NETWORK_ERROR_CODE,
        message: error.message,
      };
      return { kind: 'error', info, action: mapErrorToAction(info) };
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

  /**
   * Where `logs/read-aloud-sent.log` goes for a document: its workspace
   * folder, or the extension's global storage when it has none (or is not a
   * local file). Announced once per directory in the output channel.
   */
  private sentLogDirFor(sourceUri: string): string {
    let dir = this.globalStorageDir;
    try {
      const uri = vscode.Uri.parse(sourceUri);
      const folder = vscode.workspace.getWorkspaceFolder(uri);
      if (folder && folder.uri.scheme === 'file') {
        dir = folder.uri.fsPath;
      }
    } catch {
      // Fall back to global storage.
    }
    if (!this.announcedLogDirs.has(dir)) {
      this.announcedLogDirs.add(dir);
      readAloudLog(`sent text is appended to ${sentLogPath(dir)}`);
    }
    return dir;
  }

  private makeClient(baseUrl: string, apiKey: string): ElevenLabsClient {
    return new ElevenLabsClient({
      baseUrl,
      apiKey,
      timeoutMs: TIMEOUT_MS,
      log: (line) => readAloudLog(line),
    });
  }

  private requireClient(state: RunState): ElevenLabsClient {
    if (!state.client) {
      throw new Error('read aloud: ElevenLabs client was not created');
    }
    return state.client;
  }

  private makeKokoroClient(baseUrl: string): KokoroClient {
    return new KokoroClient({
      baseUrl,
      timeoutMs: KOKORO_TIMEOUT_MS,
      log: (line) => readAloudLog(line),
    });
  }

  private requireKokoroClient(state: RunState): KokoroClient {
    if (!state.kokoroClient) {
      throw new Error('read aloud: Kokoro client was not created');
    }
    return state.kokoroClient;
  }

  private peekModelLimits(modelId: string): ModelLimits {
    return (
      this.modelLimits.get(modelId) ?? limitFromModel(undefined, true, modelId)
    );
  }

  /** Decision L — `/v1/models` once per session, in the background. */
  private loadModelLimits(client: ElevenLabsClient): Promise<void> {
    if (this.modelLimitsPromise) {
      return this.modelLimitsPromise;
    }
    this.modelLimitsPromise = (async () => {
      try {
        const { models } = await client.listModels();
        let free = true;
        try {
          const subscription = await client.getSubscription();
          free = isFreeSubscription(subscription.status, subscription.tier);
        } catch (error) {
          readAloudLog(`subscription lookup failed: ${String(error)}`);
        }
        for (const modelId of MODEL_IDS) {
          const limits = limitFromModel(
            findModel(models, modelId),
            free,
            modelId,
          );
          this.modelLimits.set(modelId, limits);
          readAloudLog(
            `model limit ${modelId}=${limits.maxChars} source=${limits.source} free=${free}`,
          );
        }
      } catch (error) {
        readAloudLog(
          `model limits unavailable, using fallbacks: ${String(error)}`,
        );
        this.modelLimitsPromise = null;
      }
    })();
    return this.modelLimitsPromise;
  }

  private async readQuota(
    state: RunState,
    signal: AbortSignal,
  ): Promise<{ used: number; limit: number } | undefined> {
    try {
      const subscription =
        await this.requireClient(state).getSubscription(signal);
      return {
        used: subscription.characterCount,
        limit: subscription.characterLimit,
      };
    } catch (error) {
      readAloudLog(`quota lookup failed: ${String(error)}`);
      return undefined;
    }
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
      textLength: chunk.text.length,
      text: chunk.text,
      model: state.modelId,
      voice: state.voice?.voiceId ?? '',
      cache,
      meta,
      error,
    });
  }

  private reportCommandError(
    error: unknown,
    repromptOnAuthFailure: boolean,
  ): void {
    const classified = this.classify(error);
    if (classified.kind === 'aborted') {
      return;
    }
    readAloudLog(`command failed: ${classified.info.message}`);
    if (classified.action.kind === 'promptApiKey' && repromptOnAuthFailure) {
      void this.setApiKeyCommand();
      return;
    }
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
