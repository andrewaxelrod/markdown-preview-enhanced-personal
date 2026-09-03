import type { KokoroWord } from './kokoro-alignment';
import type {
  CaptionedSpeechRequestWire,
  CaptionedSpeechResponseWire,
  KokoroErrorBodyWire,
  KokoroErrorDetailWire,
  KokoroHealthWire,
  KokoroVoicesWire,
  KokoroVoiceWire,
  WordTimestampWire,
} from './kokoro-types';
import { assertSpeakable } from './speakable';

/**
 * The Kokoro-FastAPI transport: the local, free, offline text-to-speech
 * server behind every read. Plain `fetch`, no `vscode` import, one request
 * per method call, a stubbed `fetchImpl` for tests; no API key, no credits
 * and no per-model character limits: the server runs on this machine and
 * chunks internally.
 *
 * Only the timestamped endpoint is used for speech, which is what drives the
 * word highlight; see `kokoro-alignment.ts` for how the server's per-token
 * times become word spans.
 */

/** Status and timing of one server response, for the output channel. */
export interface ResponseMeta {
  status: number;
  requestId: string | null;
  durationMs: number;
}

export const DEFAULT_KOKORO_BASE_URL = 'http://127.0.0.1:8880';

/** Kokoro's showcase voice (grade A on the model card). */
export const DEFAULT_KOKORO_VOICE = 'af_heart';

/** What the cache key, the log and the player bar show as the "model". */
export const KOKORO_MODEL_ID = 'kokoro';

/**
 * A local synthesis of a ~700-character chunk takes a second or two on Apple
 * Silicon and well under a minute on any CPU; a shorter timeout would cut
 * off a slow machine's first (cold) request while the model warms up.
 */
export const KOKORO_TIMEOUT_MS = 60000;

/**
 * The server accepts any length and splits internally; this only bounds one
 * request so a stop never wastes more than a few seconds of synthesis and the
 * chunker's targets still apply.
 */
export const KOKORO_REQUEST_LIMIT_CHARS = 5000;

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set([
  'localhost',
  '127.0.0.1',
  '[::1]',
  '::1',
]);

/**
 * `https://` anywhere, or plain `http://` on the loopback interface only: the
 * text of the document travels to this URL, so it must never be redirected to
 * an unencrypted remote host.
 */
export function isAllowedKokoroBaseUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol === 'https:') {
    return true;
  }
  if (url.protocol === 'http:') {
    return LOOPBACK_HOSTS.has(url.hostname);
  }
  return false;
}

const LANGUAGE_BY_PREFIX: Readonly<Record<string, string>> = {
  a: 'American English',
  b: 'British English',
  e: 'Spanish',
  f: 'French',
  h: 'Hindi',
  i: 'Italian',
  j: 'Japanese',
  p: 'Brazilian Portuguese',
  z: 'Mandarin Chinese',
};

/**
 * Kokoro voice ids encode language and gender in their first two letters
 * (`af_heart` = American English, female). Blends are `a+b` lists.
 */
export function describeKokoroVoice(voiceId: string): string {
  const parts = voiceId.split('+').map((part) => part.trim());
  const described = parts.map((part) => {
    const language = LANGUAGE_BY_PREFIX[part.charAt(0)];
    const gender =
      part.charAt(1) === 'f' ? 'female' : part.charAt(1) === 'm' ? 'male' : '';
    if (!language) {
      return '';
    }
    return gender ? `${language}, ${gender}` : language;
  });
  const unique = Array.from(new Set(described.filter((d) => d.length > 0)));
  if (unique.length === 0) {
    return '';
  }
  return parts.length > 1 ? `blend: ${unique.join(' + ')}` : unique[0];
}

export interface KokoroClientOptions {
  baseUrl: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
}

/** The parsed `detail` of a non-2xx body. */
export interface KokoroErrorDetail {
  error: string;
  message: string;
  type: string;
}

/** A non-2xx response. */
export class KokoroHttpError extends Error {
  public readonly status: number;
  public readonly detail: KokoroErrorDetail;
  public readonly meta: ResponseMeta;

  constructor(status: number, detail: KokoroErrorDetail, meta: ResponseMeta) {
    super(detail.message);
    this.name = 'KokoroHttpError';
    this.status = status;
    this.detail = detail;
    this.meta = meta;
  }
}

/** The request never produced a response: server not running, or timeout. */
export class KokoroNetworkError extends Error {
  public readonly timedOut: boolean;
  public readonly baseUrl: string;
  public readonly cause?: unknown;

  constructor(
    message: string,
    timedOut: boolean,
    baseUrl: string,
    reason?: unknown,
  ) {
    super(message);
    this.name = 'KokoroNetworkError';
    this.timedOut = timedOut;
    this.baseUrl = baseUrl;
    this.cause = reason;
  }
}

/** The caller's `AbortSignal` fired: the job was superseded, stopped or closed. */
export class KokoroCancelledError extends Error {
  constructor(message = 'Kokoro request cancelled.') {
    super(message);
    this.name = 'KokoroCancelledError';
  }
}

export interface KokoroSynthesizeParams {
  voice: string;
  text: string;
}

export interface KokoroSynthesizeResult {
  audioBase64: string;
  /** `undefined` when the server sent no usable `timestamps`. */
  words: KokoroWord[] | undefined;
  meta: ResponseMeta;
}

export interface KokoroVoice {
  id: string;
  grade: string;
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

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Normalise `{ detail: {...} }`, `{ detail: 'text' }`, a bare string or nothing. */
export function parseKokoroError(
  status: number,
  body: unknown,
  fallbackMessage: string,
): KokoroErrorDetail {
  let detail: KokoroErrorDetailWire | undefined;
  let text: string | undefined;
  if (typeof body === 'string') {
    text = body;
  } else if (body && typeof body === 'object') {
    const raw = (body as KokoroErrorBodyWire).detail;
    if (typeof raw === 'string') {
      text = raw;
    } else if (raw && typeof raw === 'object') {
      detail = raw;
    }
  }
  const message =
    asString(detail?.message) ||
    (text && text.length > 0 ? text : '') ||
    fallbackMessage ||
    `Kokoro request failed with status ${status}.`;
  return {
    error: asString(detail?.error),
    message,
    type: asString(detail?.type),
  };
}

/** Wire timestamps -> {@link KokoroWord}[]; `undefined` unless at least one is usable. */
export function wordsFromWire(
  timestamps: WordTimestampWire[] | null | undefined,
): KokoroWord[] | undefined {
  if (!Array.isArray(timestamps)) {
    return undefined;
  }
  const words: KokoroWord[] = [];
  for (const entry of timestamps) {
    if (
      !entry ||
      typeof entry !== 'object' ||
      typeof entry.word !== 'string' ||
      typeof entry.start_time !== 'number' ||
      typeof entry.end_time !== 'number' ||
      !Number.isFinite(entry.start_time) ||
      !Number.isFinite(entry.end_time)
    ) {
      continue;
    }
    words.push({
      word: entry.word,
      start: entry.start_time,
      end: Math.max(entry.start_time, entry.end_time),
    });
  }
  return words.length > 0 ? words : undefined;
}

export class KokoroClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly log?: (line: string) => void;

  constructor(options: KokoroClientOptions) {
    this.baseUrl = (options.baseUrl || DEFAULT_KOKORO_BASE_URL).replace(
      /\/+$/,
      '',
    );
    this.timeoutMs = options.timeoutMs ?? KOKORO_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.log = options.log;
  }

  public get url(): string {
    return this.baseUrl;
  }

  /**
   * `POST /dev/captioned_speech`, non-streaming, mp3, with word timestamps
   * and the server's text normaliser off (see `kokoro-types.ts`).
   *
   * Refuses (throws before any request) when the text carries a character
   * outside the speakable set (F5).
   */
  public async synthesize(
    params: KokoroSynthesizeParams,
    signal?: AbortSignal,
  ): Promise<KokoroSynthesizeResult> {
    assertSpeakable(params.text, 'text');
    const body: CaptionedSpeechRequestWire = {
      model: 'kokoro',
      input: params.text,
      voice: params.voice,
      speed: 1,
      // eslint-disable-next-line @typescript-eslint/naming-convention -- wire format
      response_format: 'mp3',
      stream: false,
      // eslint-disable-next-line @typescript-eslint/naming-convention -- wire format
      return_timestamps: true,
      // eslint-disable-next-line @typescript-eslint/naming-convention -- wire format
      normalization_options: { normalize: false },
    };
    const { json, meta } = await this.request<CaptionedSpeechResponseWire>({
      method: 'POST',
      path: '/dev/captioned_speech',
      body,
      signal,
    });
    if (!json || typeof json.audio !== 'string' || json.audio.length === 0) {
      throw new Error('Kokoro response did not contain audio.');
    }
    return {
      audioBase64: json.audio,
      words: wordsFromWire(json.timestamps),
      meta,
    };
  }

  /** `GET /v1/audio/voices`. */
  public async listVoices(
    signal?: AbortSignal,
  ): Promise<{ voices: KokoroVoice[]; meta: ResponseMeta }> {
    const { json, meta } = await this.request<KokoroVoicesWire>({
      method: 'GET',
      path: '/v1/audio/voices',
      signal,
    });
    const voices: KokoroVoice[] = [];
    const raw: KokoroVoiceWire[] = Array.isArray(json?.voices)
      ? json.voices
      : [];
    for (const wire of raw) {
      if (!wire || typeof wire.id !== 'string' || wire.id.length === 0) {
        continue;
      }
      voices.push({ id: wire.id, grade: asString(wire.overall_grade) });
    }
    return { voices, meta };
  }

  /** `GET /health`; resolves to the reported status string. */
  public async health(signal?: AbortSignal): Promise<string> {
    const { json } = await this.request<KokoroHealthWire>({
      method: 'GET',
      path: '/health',
      signal,
    });
    return asString(json?.status) || 'ok';
  }

  private async request<T>(
    options: RequestOptions,
  ): Promise<{ json: T; meta: ResponseMeta }> {
    const url = `${this.baseUrl}${options.path}`;
    const controller = new AbortController();
    let timedOut = false;
    let cancelled = false;

    if (options.signal?.aborted) {
      throw new KokoroCancelledError();
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
      Accept: 'application/json',
    };
    if (options.method === 'POST') {
      headers['Content-Type'] = 'application/json';
    }

    const transportFailure = (error: unknown): Error => {
      if (cancelled) {
        return new KokoroCancelledError();
      }
      if (timedOut) {
        return new KokoroNetworkError(
          `Kokoro request timed out after ${Math.round(
            this.timeoutMs / 1000,
          )} s.`,
          true,
          this.baseUrl,
        );
      }
      return new KokoroNetworkError(
        `Could not reach the Kokoro server at ${this.baseUrl}. Start it and try again.`,
        false,
        this.baseUrl,
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
        requestId: headerOf(response, 'x-request-id'),
        durationMs: Date.now() - startedAt,
      };
      this.logTransport(options.method, options.path, meta);

      let raw = '';
      try {
        raw = await response.text();
      } catch (error) {
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
        throw new KokoroHttpError(
          response.status,
          parseKokoroError(
            response.status,
            parsed,
            `Kokoro request failed with status ${response.status}.`,
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
    this.log(
      `http ${method} ${path} status=${meta.status} dur=${meta.durationMs}ms`,
    );
  }
}
