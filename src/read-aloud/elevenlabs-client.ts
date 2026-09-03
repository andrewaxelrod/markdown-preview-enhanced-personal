import type {
  ModelWire,
  SubscriptionWire,
  VoiceDetailWire,
  VoicesPageWire,
  VoiceWire,
  WithTimestampsRequestWire,
  WithTimestampsResponseWire,
} from './elevenlabs-types';
import {
  parseElevenLabsError,
  TIMEOUT_MS,
  type ElevenLabsErrorInfo,
} from './error-mapping';
import { assertSpeakable } from './speakable';
import { alignmentFromWire, type Alignment } from './word-spans';

/**
 * The ElevenLabs REST transport (decision D1, R2 §4.6).
 *
 * Plain `fetch` — VS Code 1.82 ships Electron 25 / Node 18.15, so `fetch` is a
 * global in the extension host and no SDK dependency is needed. No `vscode`
 * import, so the client is unit-testable with a stubbed `fetchImpl`.
 *
 * Exactly one request is issued per method call; retries and backoff live in
 * the controller's sequential job loop, never here (decision (k)).
 */

export const DEFAULT_BASE_URL = 'https://api.elevenlabs.io';

/**
 * R2 §8.5 — 64 kbps is transparent for speech, needs no paid tier, plays
 * natively in `<audio>`, and halves the base64 payload, the `postMessage`
 * and the on-disk cache entry compared with the endpoint default of 128 kbps.
 */
export const OUTPUT_FORMAT = 'mp3_44100_64';

export interface ClientOptions {
  baseUrl: string;
  apiKey: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
}

/** Headers and timing worth logging for every call (spec §9). */
export interface ResponseMeta {
  status: number;
  requestId: string | null;
  characterCost: string | null;
  region: string | null;
  concurrentRequests: string | null;
  durationMs: number;
}

/** A non-2xx response; `info` is the parsed R2 §9.1 error body. */
export class ElevenLabsHttpError extends Error {
  public readonly info: ElevenLabsErrorInfo;
  public readonly meta: ResponseMeta;

  constructor(info: ElevenLabsErrorInfo, meta: ResponseMeta) {
    super(info.message);
    this.name = 'ElevenLabsHttpError';
    this.info = info;
    this.meta = meta;
  }
}

/** The request never produced a response: transport failure or our 30 s timeout. */
export class ElevenLabsNetworkError extends Error {
  public readonly timedOut: boolean;
  public readonly cause?: unknown;

  constructor(message: string, timedOut: boolean, reason?: unknown) {
    super(message);
    this.name = 'ElevenLabsNetworkError';
    this.timedOut = timedOut;
    this.cause = reason;
  }
}

/** The caller's `AbortSignal` fired: the job was superseded, stopped or closed. */
export class ElevenLabsCancelledError extends Error {
  constructor(message = 'ElevenLabs request cancelled.') {
    super(message);
    this.name = 'ElevenLabsCancelledError';
  }
}

export interface SynthesizeParams {
  voiceId: string;
  modelId: string;
  text: string;
  previousText?: string;
  nextText?: string;
}

export interface SynthesizeResult {
  audioBase64: string;
  alignment: Alignment | undefined;
  meta: ResponseMeta;
}

interface RequestOptions {
  method: 'GET' | 'POST';
  path: string;
  body?: unknown;
  signal?: AbortSignal;
}

function headerOf(response: Response, name: string): string | null {
  try {
    return response.headers.get(name);
  } catch {
    return null;
  }
}

export class ElevenLabsClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly log?: (line: string) => void;

  constructor(options: ClientOptions) {
    this.baseUrl = (options.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.log = options.log;
  }

  /**
   * `POST /v1/text-to-speech/{voice_id}/with-timestamps` (R2 §4.1, §4.2).
   *
   * `alignment` is used, never `normalized_alignment`: the normalized text is
   * not the text the webview built its offset map from.
   *
   * Refuses (throws before any request) when a field carries a character
   * outside the speakable set — letters, digits, whitespace and sentence
   * punctuation — so markdown residue and symbols can never reach the API
   * even if a caller skips `sanitizeForSpeech`.
   */
  public async synthesizeWithTimestamps(
    params: SynthesizeParams,
    signal?: AbortSignal,
  ): Promise<SynthesizeResult> {
    assertSpeakable(params.text, 'text');
    if (params.previousText) {
      assertSpeakable(params.previousText, 'previous_text');
    }
    if (params.nextText) {
      assertSpeakable(params.nextText, 'next_text');
    }
    const body: WithTimestampsRequestWire = {
      text: params.text,
      // eslint-disable-next-line @typescript-eslint/naming-convention -- wire format
      model_id: params.modelId,
      // eslint-disable-next-line @typescript-eslint/naming-convention -- wire format
      apply_text_normalization: 'auto',
    };
    if (params.previousText) {
      body.previous_text = params.previousText;
    }
    if (params.nextText) {
      body.next_text = params.nextText;
    }
    const path = `/v1/text-to-speech/${encodeURIComponent(
      params.voiceId,
    )}/with-timestamps?output_format=${OUTPUT_FORMAT}`;
    const { json, meta } = await this.request<WithTimestampsResponseWire>({
      method: 'POST',
      path,
      body,
      signal,
    });
    if (
      !json ||
      typeof json.audio_base64 !== 'string' ||
      json.audio_base64.length === 0
    ) {
      throw new Error('ElevenLabs response did not contain audio.');
    }
    return {
      audioBase64: json.audio_base64,
      alignment: alignmentFromWire(json.alignment),
      meta,
    };
  }

  /** `GET /v2/voices` (R2 §7.2). */
  public async listVoices(
    pageSize: number,
    nextPageToken?: string,
    signal?: AbortSignal,
  ): Promise<{
    voices: VoiceWire[];
    hasMore: boolean;
    nextPageToken: string | null;
    meta: ResponseMeta;
  }> {
    const size = Math.min(100, Math.max(1, Math.floor(pageSize)));
    let path = `/v2/voices?page_size=${size}`;
    if (nextPageToken) {
      path += `&next_page_token=${encodeURIComponent(nextPageToken)}`;
    }
    const { json, meta } = await this.request<VoicesPageWire>({
      method: 'GET',
      path,
      signal,
    });
    return {
      voices: Array.isArray(json?.voices) ? json.voices : [],
      hasMore: json?.has_more === true,
      nextPageToken:
        typeof json?.next_page_token === 'string' ? json.next_page_token : null,
      meta,
    };
  }

  /** `GET /v1/voices/{voice_id}` (R2 §7.3). */
  public async getVoice(
    voiceId: string,
    signal?: AbortSignal,
  ): Promise<{ voiceId: string; name: string; meta: ResponseMeta }> {
    const { json, meta } = await this.request<VoiceDetailWire>({
      method: 'GET',
      path: `/v1/voices/${encodeURIComponent(voiceId)}`,
      signal,
    });
    return {
      voiceId: typeof json?.voice_id === 'string' ? json.voice_id : voiceId,
      name: typeof json?.name === 'string' ? json.name : voiceId,
      meta,
    };
  }

  /** `GET /v1/models` (R2 §8.3). */
  public async listModels(
    signal?: AbortSignal,
  ): Promise<{ models: ModelWire[]; meta: ResponseMeta }> {
    const { json, meta } = await this.request<ModelWire[]>({
      method: 'GET',
      path: '/v1/models',
      signal,
    });
    return { models: Array.isArray(json) ? json : [], meta };
  }

  /** `GET /v1/user/subscription` (R2 §10.1); also the key-validation call (F7). */
  public async getSubscription(signal?: AbortSignal): Promise<{
    tier: string;
    status: string;
    characterCount: number;
    characterLimit: number;
    meta: ResponseMeta;
  }> {
    const { json, meta } = await this.request<SubscriptionWire>({
      method: 'GET',
      path: '/v1/user/subscription',
      signal,
    });
    return {
      tier: typeof json?.tier === 'string' ? json.tier : '',
      status: typeof json?.status === 'string' ? json.status : '',
      characterCount:
        typeof json?.character_count === 'number' ? json.character_count : 0,
      characterLimit:
        typeof json?.character_limit === 'number' ? json.character_limit : 0,
      meta,
    };
  }

  /**
   * One `fetch`, with a per-request `AbortController` aborted by our own timer
   * and by the caller's signal. Transport fields only reach `log` — the
   * controller composes the single `tts …` line per attempt (A-22).
   */
  private async request<T>(
    options: RequestOptions,
  ): Promise<{ json: T; meta: ResponseMeta }> {
    const url = `${this.baseUrl}${options.path}`;
    const controller = new AbortController();
    let timedOut = false;
    let cancelled = false;

    if (options.signal?.aborted) {
      throw new ElevenLabsCancelledError();
    }
    const onAbort = () => {
      cancelled = true;
      controller.abort();
    };
    options.signal?.addEventListener('abort', onAbort);
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);

    const headers: Record<string, string> = {
      // eslint-disable-next-line @typescript-eslint/naming-convention -- HTTP header name
      'xi-api-key': this.apiKey,
      // eslint-disable-next-line @typescript-eslint/naming-convention -- HTTP header name
      'Accept': 'application/json',
    };
    if (options.method === 'POST') {
      headers['Content-Type'] = 'application/json';
    }

    // A failure of the fetch itself and a failure while the body streams are
    // classified alike: the timer and the caller's signal stay armed until
    // `finally`, and a multi-hundred-KB base64 audio body on a slow link is
    // exactly what the F10 timeout row exists for.
    const transportFailure = (error: unknown): Error => {
      if (cancelled) {
        return new ElevenLabsCancelledError();
      }
      if (timedOut) {
        return new ElevenLabsNetworkError(
          `ElevenLabs request timed out after ${this.timeoutMs} ms.`,
          true,
        );
      }
      return new ElevenLabsNetworkError(
        error instanceof Error ? error.message : String(error),
        false,
        error,
      );
    };

    const startedAt = Date.now();
    try {
      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method: options.method,
          headers,
          body:
            options.body === undefined
              ? undefined
              : JSON.stringify(options.body),
          signal: controller.signal,
        });
      } catch (error) {
        throw transportFailure(error);
      }

      const meta: ResponseMeta = {
        status: response.status,
        requestId: headerOf(response, 'request-id'),
        characterCost: headerOf(response, 'character-cost'),
        region: headerOf(response, 'x-region'),
        concurrentRequests: headerOf(response, 'current-concurrent-requests'),
        durationMs: Date.now() - startedAt,
      };
      this.logTransport(options.method, options.path, meta);

      let raw = '';
      try {
        raw = await response.text();
      } catch (error) {
        // On a non-2xx the status alone classifies the failure and the body
        // is best effort; everywhere else a truncated or aborted body is a
        // transport failure, never "response did not contain audio".
        if (cancelled || timedOut || response.ok) {
          throw transportFailure(error);
        }
      }
      let parsed: unknown;
      try {
        parsed = raw.length > 0 ? JSON.parse(raw) : undefined;
      } catch {
        parsed = raw;
      }

      if (!response.ok) {
        throw new ElevenLabsHttpError(
          parseElevenLabsError(
            response.status,
            parsed,
            `ElevenLabs request failed with status ${response.status}.`,
          ),
          meta,
        );
      }
      return { json: parsed as T, meta };
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
    }
  }

  private logTransport(method: string, path: string, meta: ResponseMeta): void {
    if (!this.log) {
      return;
    }
    const pathOnly = path.split('?')[0];
    this.log(
      `http ${method} ${pathOnly} status=${meta.status} request-id=${
        meta.requestId ?? 'null'
      } character-cost=${meta.characterCost ?? 'null'} x-region=${
        meta.region ?? 'null'
      } dur=${meta.durationMs}ms`,
    );
  }
}
