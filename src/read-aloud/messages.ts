import type { WordSpan } from './word-spans';

/**
 * The F13 message contract plus the validators that guard the host boundary
 * (spec §6 Security, contract §2 "Host validation").
 *
 * Pure module: no `vscode`, no I/O. Every webview -> host payload is parsed
 * here before the controller ever sees it; anything that does not match the
 * exact F13 shape is dropped.
 */

/** Defence in depth: the model limit is applied later, in the chunker. */
export const MAX_TEXT_CHARS = 200000;

/** F11 — `previous_text` / `next_text` windows. */
export const MAX_CONTEXT_CHARS = 300;

export const MAX_BLOCK_ID_CHARS = 128;

export const REQUEST_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** F3 — the playback rate range. */
export const SPEED_MIN = 0.25;
export const SPEED_MAX = 4;

/**
 * F4 — the ElevenLabs Reader "Player highlight theme" palettes. Same list as
 * `HIGHLIGHT_THEMES` in media/read-aloud-core.js; the colours live in
 * media/read-aloud.css.
 */
export const HIGHLIGHT_THEMES = ['blue', 'orange', 'yellow', 'green'] as const;
export type ReadAloudHighlightTheme = (typeof HIGHLIGHT_THEMES)[number];
export const DEFAULT_HIGHLIGHT_THEME: ReadAloudHighlightTheme = 'blue';

export function normaliseHighlightTheme(
  value: unknown,
): ReadAloudHighlightTheme {
  return typeof value === 'string' &&
    (HIGHLIGHT_THEMES as readonly string[]).includes(value)
    ? (value as ReadAloudHighlightTheme)
    : DEFAULT_HIGHLIGHT_THEME;
}

export type ReadAloudKind = 'block' | 'selection';

export interface SynthesizeOptions {
  kind: ReadAloudKind;
  blockId?: string;
  previousText?: string;
  nextText?: string;
}

export interface SynthesizeRequest {
  sourceUri: string;
  requestId: string;
  text: string;
  options: SynthesizeOptions;
}

export interface CancelRequest {
  sourceUri: string;
  requestId: string;
}

/** `readAloudPlaying`: the webview started playing chunk `chunkIndex`. */
export interface PlayingRequest {
  sourceUri: string;
  requestId: string;
  chunkIndex: number;
}

export interface ReadAloudAudioMessage {
  command: 'readAloudAudio';
  requestId: string;
  chunkIndex: number;
  chunkCount: number;
  audioBase64: string;
  mimeType: 'audio/mpeg';
  spans: WordSpan[] | null;
  durationHint?: number;
}

export interface ReadAloudErrorMessage {
  command: 'readAloudError';
  requestId: string;
  code: string;
  message: string;
  retryable: boolean;
}

export interface ReadAloudConfigMessage {
  command: 'readAloudConfig';
  enabled: boolean;
  /** F17 — a plain click on a word starts reading there. */
  clickToRead: boolean;
  speed: number;
  voiceName: string;
  modelId: string;
  highlightTheme: ReadAloudHighlightTheme;
}

export type ReadAloudControlAction =
  'stop' | 'togglePlayPause' | 'readSelection';

export interface ReadAloudControlMessage {
  command: 'readAloudControl';
  action: ReadAloudControlAction;
}

export type HostToWebviewMessage =
  | ReadAloudAudioMessage
  | ReadAloudErrorMessage
  | ReadAloudConfigMessage
  | ReadAloudControlMessage;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalContext(
  value: unknown,
  take: 'tail' | 'head',
): { ok: boolean; value?: string } {
  if (value === undefined || value === null) {
    return { ok: true };
  }
  if (typeof value !== 'string') {
    return { ok: false };
  }
  if (value.length <= MAX_CONTEXT_CHARS) {
    return { ok: true, value };
  }
  return {
    ok: true,
    value:
      take === 'tail'
        ? value.slice(value.length - MAX_CONTEXT_CHARS)
        : value.slice(0, MAX_CONTEXT_CHARS),
  };
}

/**
 * `readAloudSynthesize` -> `[sourceUri, requestId, text, options]` (F13).
 *
 * Untrimmed text is rejected rather than trimmed (A-25): the webview built its
 * offset map against the exact string it sent, so silently changing it here
 * would shift every word span by the amount trimmed.
 */
export function parseSynthesizeArgs(
  args: unknown,
): SynthesizeRequest | undefined {
  if (!Array.isArray(args) || args.length !== 4) {
    return undefined;
  }
  const [sourceUri, requestId, text, rawOptions] = args as unknown[];
  if (typeof sourceUri !== 'string' || sourceUri.length === 0) {
    return undefined;
  }
  if (typeof requestId !== 'string' || !REQUEST_ID_RE.test(requestId)) {
    return undefined;
  }
  if (
    typeof text !== 'string' ||
    text.length === 0 ||
    text.length > MAX_TEXT_CHARS
  ) {
    return undefined;
  }
  if (text !== text.trim()) {
    return undefined;
  }
  if (!isPlainObject(rawOptions)) {
    return undefined;
  }
  const kind = rawOptions.kind;
  if (kind !== 'block' && kind !== 'selection') {
    return undefined;
  }
  const options: SynthesizeOptions = { kind };
  const blockId = rawOptions.blockId;
  if (blockId !== undefined && blockId !== null) {
    if (typeof blockId !== 'string' || blockId.length > MAX_BLOCK_ID_CHARS) {
      return undefined;
    }
    options.blockId = blockId;
  }
  const previousText = optionalContext(rawOptions.previousText, 'tail');
  if (!previousText.ok) {
    return undefined;
  }
  if (previousText.value !== undefined) {
    options.previousText = previousText.value;
  }
  const nextText = optionalContext(rawOptions.nextText, 'head');
  if (!nextText.ok) {
    return undefined;
  }
  if (nextText.value !== undefined) {
    options.nextText = nextText.value;
  }
  return { sourceUri, requestId, text, options };
}

/** `readAloudCancel` -> `[sourceUri, requestId]` (F13). */
export function parseCancelArgs(args: unknown): CancelRequest | undefined {
  if (!Array.isArray(args) || args.length !== 2) {
    return undefined;
  }
  const [sourceUri, requestId] = args as unknown[];
  if (typeof sourceUri !== 'string' || sourceUri.length === 0) {
    return undefined;
  }
  if (typeof requestId !== 'string' || !REQUEST_ID_RE.test(requestId)) {
    return undefined;
  }
  return { sourceUri, requestId };
}

/**
 * `readAloudPlaying` -> `[sourceUri, requestId, chunkIndex]` (F11 lazy
 * synthesis): the host requests the next billable chunk only after this one
 * is playing. A non-integer or negative index is dropped.
 */
export function parsePlayingArgs(args: unknown): PlayingRequest | undefined {
  if (!Array.isArray(args) || args.length !== 3) {
    return undefined;
  }
  const [sourceUri, requestId, chunkIndex] = args as unknown[];
  if (typeof sourceUri !== 'string' || sourceUri.length === 0) {
    return undefined;
  }
  if (typeof requestId !== 'string' || !REQUEST_ID_RE.test(requestId)) {
    return undefined;
  }
  if (
    typeof chunkIndex !== 'number' ||
    !Number.isInteger(chunkIndex) ||
    chunkIndex < 0
  ) {
    return undefined;
  }
  return { sourceUri, requestId, chunkIndex };
}

/**
 * `readAloudSetSpeed` -> `[rate]` (F13). An out-of-range rate is rejected, not
 * clamped: the webview offers only in-range values, so anything else is a bug
 * or a rogue message.
 */
export function parseSetSpeedArgs(args: unknown): number | undefined {
  if (!Array.isArray(args) || args.length !== 1) {
    return undefined;
  }
  const rate = args[0] as unknown;
  if (typeof rate !== 'number' || !Number.isFinite(rate)) {
    return undefined;
  }
  if (rate < SPEED_MIN || rate > SPEED_MAX) {
    return undefined;
  }
  return rate;
}

/** Clamp a rate read from the settings file, which the user can edit freely. */
export function clampSpeed(rate: number): number {
  if (typeof rate !== 'number' || !Number.isFinite(rate)) {
    return 1;
  }
  return Math.min(SPEED_MAX, Math.max(SPEED_MIN, rate));
}
