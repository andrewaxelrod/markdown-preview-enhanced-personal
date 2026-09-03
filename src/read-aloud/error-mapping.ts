/**
 * Kokoro-FastAPI failures -> the user-facing action table (F10).
 *
 * Pure module: no `vscode`, no I/O, never throws. The server's `detail.error`
 * is only a category (`validation_error`, `processing_error`), so the code the
 * webview needs is derived from the message where it matters.
 */

/** F10 — "Wait 1s, 2s, 4s; retry up to 3 times" on a 429. */
export const RETRY_BACKOFF_MS: readonly number[] = [1000, 2000, 4000];

/** Our own code for a transport failure (server not running, timeout). */
export const NETWORK_ERROR_CODE = 'network_error';

/** Our own code for a superseded/aborted job. */
export const CANCELLED_CODE = 'cancelled';

/**
 * Codes that must produce no inline UI in the webview (decision G, G-08):
 * a cancelled job and text the server found nothing to say for.
 */
export const SILENT_CODES: ReadonlySet<string> = new Set([
  'empty_text',
  CANCELLED_CODE,
]);

/** A normalised failure. `status` is the HTTP status (0 = transport). */
export interface ReadAloudErrorInfo {
  status: number;
  type: string;
  code: string;
  message: string;
}

/** The single user-facing action an error maps to (spec F10). */
export type ErrorAction =
  | { kind: 'ignore' }
  | { kind: 'backoff'; delaysMs: readonly number[] }
  | { kind: 'serverError' }
  | { kind: 'network' }
  | { kind: 'unknown' };

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Kokoro-FastAPI's "Input contains no speakable text" (HTTP 400). */
const KOKORO_NO_SPEAKABLE_RE = /no speakable text/i;

/** Kokoro-FastAPI's "Voice 'x' not found. Available voices: …" (HTTP 400). */
const KOKORO_VOICE_NOT_FOUND_RE = /^Voice '([^']*)' not found/;

/**
 * Normalise a Kokoro-FastAPI failure into {@link ReadAloudErrorInfo}.
 * `status` 0 is a transport failure (server not running, timeout).
 * `empty_text` is silent (F10) and `voice_not_found` gets a short message
 * instead of the server's list of every voice.
 */
export function kokoroErrorInfo(
  status: number,
  detail: { error?: string; message?: string; type?: string },
): ReadAloudErrorInfo {
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
  };
}

/**
 * The action table for a local server: nothing to do with keys, credits or
 * model limits. A missing voice is reported inline (the user picks another
 * one); a transport failure is reported inline and retryable by hand.
 */
export function mapKokoroErrorToAction(info: ReadAloudErrorInfo): ErrorAction {
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

/** The exact user-facing string for an error (spec F10). */
export function userMessageFor(
  info: ReadAloudErrorInfo,
  action: ErrorAction,
): string {
  switch (action.kind) {
    case 'network':
      return info.message;
    case 'serverError':
      return `Kokoro server error: ${info.message}`;
    case 'ignore':
      return '';
    case 'backoff':
    case 'unknown':
    default:
      return info.message;
  }
}
