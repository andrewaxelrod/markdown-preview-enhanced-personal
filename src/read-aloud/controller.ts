import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  CACHE_DIR_NAME,
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
import type {
  CancelRequest,
  HostToWebviewMessage,
  PlayingRequest,
  ReadAloudConfigMessage,
  ReadAloudControlAction,
  ReadAloudFont,
  ReadAloudHighlightTheme,
  ReadAloudKind,
  SynthesizeRequest,
} from './messages';
import {
  readReadAloudSettings,
  writeFontSetting,
  writeHighlightThemeSetting,
  writeSpeedSetting,
  writeVolumeSetting,
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

let instance: ReadAloudController | undefined;

export class ReadAloudController implements vscode.Disposable {
  private readonly deps: ControllerDeps;
  private readonly cache: ReadAloudCache;
  private webNoticeShown = false;
  private job: Job | null = null;

  private constructor(context: vscode.ExtensionContext, deps: ControllerDeps) {
    this.deps = deps;
    const dir = path.join(context.globalStorageUri.fsPath, CACHE_DIR_NAME);
    this.cache = new ReadAloudCache(
      dir,
      readReadAloudSettings().cacheSizeMB * BYTES_PER_MB,
    );
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
      void vscode.window.showInformationMessage(
        `Read aloud cache cleared (${removed} entries).`,
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

  // ----------------------------------------------------------------- config

  /**
   * Synchronous snapshot for the injected `data-config` attribute and every
   * `readAloudConfig` message. A Kokoro voice id is its own name, so nothing
   * is ever looked up over the network for it.
   */
  public buildInitialConfig(): ReadAloudConfigMessage {
    const settings = readReadAloudSettings();
    return {
      command: 'readAloudConfig',
      enabled: settings.enabled,
      clickToRead: settings.clickToRead,
      speed: settings.speed,
      volume: settings.volume,
      voiceName: settings.kokoroVoice,
      modelId: KOKORO_MODEL_ID,
      highlightTheme: settings.highlightTheme,
      font: settings.font,
    };
  }

  /** Posted after crossnote's `webviewFinishLoading` (contract §2 handshake). */
  public async sendConfig(sourceUri: vscode.Uri): Promise<void> {
    if (this.guardWebBuild()) {
      return;
    }
    try {
      const sink = await this.deps.getSinkFor(sourceUri);
      await sink.post(this.buildInitialConfig());
    } catch (error) {
      readAloudLog(`sendConfig failed: ${String(error)}`);
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
