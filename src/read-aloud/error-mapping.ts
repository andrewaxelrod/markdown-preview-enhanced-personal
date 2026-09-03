import type { ErrorBodyWire, ErrorDetailWire } from './elevenlabs-types';

/**
 * ElevenLabs error bodies -> the F10 action table (R2 §9).
 *
 * Pure module: no `vscode`, no I/O, never throws. `parseElevenLabsError`
 * copes with `{ detail: { … } }`, `{ detail: 'string' }`, a bare string and a
 * body that could not be parsed at all.
 */

/** F10 — network failure / timeout after 30 s. */
export const TIMEOUT_MS = 30000;

/** F10 — "Wait 1s, 2s, 4s; retry up to 3 times". */
export const RETRY_BACKOFF_MS: readonly number[] = [1000, 2000, 4000];

/** Our own code for a transport failure; not an ElevenLabs code. */
export const NETWORK_ERROR_CODE = 'network_error';

/** Our own code for a superseded/aborted job; not an ElevenLabs code. */
export const CANCELLED_CODE = 'cancelled';

/**
 * Codes that must produce no inline UI in the webview (decision G, G-08).
 * `insufficient_credits`, `feature_not_available` and `subscription_required`
 * are silent because the host has already shown a notification for them.
 */
export const SILENT_CODES: ReadonlySet<string> = new Set([
  'text_too_short',
  'empty_text',
  CANCELLED_CODE,
  'insufficient_credits',
  'feature_not_available',
  'subscription_required',
]);

/**
 * R2 §9.1 `detail`, normalised. `status` is the HTTP status (0 = transport).
 * Also the shape a Kokoro-FastAPI failure is normalised into
 * ({@link kokoroErrorInfo}), tagged with `provider: 'kokoro'` so the
 * user-facing text names the right service.
 */
export interface ElevenLabsErrorInfo {
  status: number;
  type: string;
  code: string;
  message: string;
  requestId?: string;
  param?: string;
  provider?: 'elevenlabs' | 'kokoro';
}

/** The single user-facing action an error maps to (spec F10). */
export type ErrorAction =
  | { kind: 'promptApiKey' }
  | { kind: 'reresolveVoice' }
  | { kind: 'resetModel' }
  | { kind: 'rechunk' }
  | { kind: 'ignore' }
  | { kind: 'quota' }
  | { kind: 'showVerbatim' }
  | { kind: 'backoff'; delaysMs: readonly number[] }
  | { kind: 'serverError' }
  | { kind: 'network' }
  | { kind: 'unknown' };

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function detailOf(body: unknown): { detail?: ErrorDetailWire; text?: string } {
  if (typeof body === 'string') {
    return { text: body };
  }
  if (!body || typeof body !== 'object') {
    return {};
  }
  const detail = (body as ErrorBodyWire).detail;
  if (typeof detail === 'string') {
    return { text: detail };
  }
  if (detail && typeof detail === 'object') {
    return { detail: detail as ErrorDetailWire };
  }
  return {};
}

/**
 * Normalise any error body into {@link ElevenLabsErrorInfo}. Never throws:
 * unknown shapes degrade to `code: ''` plus whatever message could be found.
 */
export function parseElevenLabsError(
  status: number,
  body: unknown,
  fallbackMessage?: string,
): ElevenLabsErrorInfo {
  const httpStatus = Number.isFinite(status) ? status : 0;
  const { detail, text } = detailOf(body);
  const message =
    asString(detail?.message) ??
    text ??
    fallbackMessage ??
    `ElevenLabs request failed with status ${httpStatus}.`;
  return {
    status: httpStatus,
    type: asString(detail?.type) ?? '',
    code: asString(detail?.code) ?? '',
    message,
    requestId: asString(detail?.request_id),
    param: asString(detail?.param),
  };
}

/** The F10 table: code first, HTTP status as the fallback. */
export function mapErrorToAction(info: ElevenLabsErrorInfo): ErrorAction {
  switch (info.code) {
    case 'missing_api_key':
    case 'invalid_api_key':
    case 'unauthorized':
      return { kind: 'promptApiKey' };
    case 'voice_not_found':
    case 'invalid_voice_id':
    case 'voice_access_denied':
      return { kind: 'reresolveVoice' };
    case 'model_not_found':
    case 'model_access_denied':
    case 'unsupported_model':
      return { kind: 'resetModel' };
    case 'text_too_long':
      return { kind: 'rechunk' };
    case 'text_too_short':
    case 'empty_text':
      return { kind: 'ignore' };
    case 'insufficient_credits':
      return { kind: 'quota' };
    case 'feature_not_available':
    case 'subscription_required':
      return { kind: 'showVerbatim' };
    case 'rate_limit_exceeded':
    case 'system_busy':
    case 'concurrent_limit_exceeded':
      return { kind: 'backoff', delaysMs: RETRY_BACKOFF_MS };
    case 'internal_error':
    case 'service_unavailable':
    case 'maintenance':
      return { kind: 'serverError' };
    case NETWORK_ERROR_CODE:
      return { kind: 'network' };
    default:
      break;
  }
  if (info.status === 0) {
    return { kind: 'network' };
  }
  if (info.status === 401) {
    return { kind: 'promptApiKey' };
  }
  if (info.status === 402) {
    return { kind: 'quota' };
  }
  if (info.status === 429) {
    return { kind: 'backoff', delaysMs: RETRY_BACKOFF_MS };
  }
  if (info.status >= 500 && info.status <= 599) {
    return { kind: 'serverError' };
  }
  return { kind: 'unknown' };
}

/** Kokoro-FastAPI's "Input contains no speakable text" (HTTP 400). */
const KOKORO_NO_SPEAKABLE_RE = /no speakable text/i;

/** Kokoro-FastAPI's "Voice 'x' not found. Available voices: …" (HTTP 400). */
const KOKORO_VOICE_NOT_FOUND_RE = /^Voice '([^']*)' not found/;

/**
 * Normalise a Kokoro-FastAPI failure into {@link ElevenLabsErrorInfo}.
 * `status` 0 is a transport failure (server not running, timeout). The
 * server's `detail.error` is a category (`validation_error`,
 * `processing_error`), so the code is derived from the message where the
 * webview needs a specific one: `empty_text` is silent (F10) and
 * `voice_not_found` gets a short message instead of the server's list of
 * every voice.
 */
export function kokoroErrorInfo(
  status: number,
  detail: { error?: string; message?: string; type?: string },
): ElevenLabsErrorInfo {
  const httpStatus = Number.isFinite(status) ? status : 0;
  const rawMessage = asString(detail.message) ?? '';
  let code = asString(detail.error) ?? '';
  let message =
    rawMessage || `Kokoro request failed with status ${httpStatus}.`;
  if (httpStatus === 0) {
    code = NETWORK_ERROR_CODE;
  } else if (KOKORO_NO_SPEAKABLE_RE.test(rawMessage)) {
    code = 'empty_text';
  } else {
    const voice = KOKORO_VOICE_NOT_FOUND_RE.exec(rawMessage);
    if (voice) {
      code = 'voice_not_found';
      message = `Kokoro voice '${voice[1]}' not found. Run "Choose Read Aloud Voice" to pick one.`;
    }
  }
  return {
    status: httpStatus,
    type: asString(detail.type) ?? (httpStatus === 0 ? 'network' : ''),
    code,
    message,
    provider: 'kokoro',
  };
}

/**
 * The action table for a local Kokoro server: nothing to do with keys,
 * credits or model limits. A missing voice is reported inline (the user
 * picks another one), not re-resolved from an account.
 */
export function mapKokoroErrorToAction(info: ElevenLabsErrorInfo): ErrorAction {
  if (info.status === 0 || info.code === NETWORK_ERROR_CODE) {
    return { kind: 'network' };
  }
  if (info.code === 'empty_text') {
    return { kind: 'ignore' };
  }
  if (info.status === 429) {
    return { kind: 'backoff', delaysMs: RETRY_BACKOFF_MS };
  }
  if (info.status >= 500 && info.status <= 599) {
    return { kind: 'serverError' };
  }
  return { kind: 'unknown' };
}

/** Whether trying the same request again could plausibly succeed. */
export function isRetryable(action: ErrorAction): boolean {
  return (
    action.kind === 'backoff' ||
    action.kind === 'network' ||
    action.kind === 'serverError'
  );
}

/** The exact user-facing string for an error (spec F10, contract §1.1). */
export function userMessageFor(
  info: ElevenLabsErrorInfo,
  action: ErrorAction,
  quota?: { used: number; limit: number },
): string {
  switch (action.kind) {
    case 'quota':
      return quota
        ? `ElevenLabs quota exhausted (${quota.used}/${quota.limit}).`
        : 'ElevenLabs quota exhausted.';
    case 'network':
      return info.provider === 'kokoro'
        ? info.message
        : 'Could not reach ElevenLabs.';
    case 'serverError':
      if (info.provider === 'kokoro') {
        return `Kokoro server error: ${info.message}`;
      }
      return info.requestId
        ? `ElevenLabs error: ${info.message} (request id ${info.requestId})`
        : `ElevenLabs error: ${info.message}`;
    case 'promptApiKey':
      return 'ElevenLabs API key missing or invalid.';
    case 'reresolveVoice':
      return 'ElevenLabs voice unavailable; resolving a default voice.';
    case 'resetModel':
      return 'ElevenLabs model unavailable; reset to eleven_multilingual_v2.';
    case 'rechunk':
      return 'Text too long for one request; splitting.';
    case 'ignore':
      return '';
    case 'showVerbatim':
    case 'unknown':
    default:
      return info.message;
  }
}
