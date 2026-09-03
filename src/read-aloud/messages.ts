import type { WordSpan } from './word-spans';

/**
 * The F13 message contract plus the validators that guard the host boundary
 * (spec §6 Security, contract §2 "Host validation").
 *
 * Pure module: no `vscode`, no I/O. Every webview -> host payload is parsed
 * here before the controller ever sees it; anything that does not match the
 * exact F13 shape is dropped.
 */

/** Defence in depth: the request limit is applied later, in the chunker. */
export const MAX_TEXT_CHARS = 200000;

export const MAX_BLOCK_ID_CHARS = 128;

/** A block key is `blockKey()` of read-aloud-core.js: `b` + 32-bit hex. */
export const MAX_BLOCK_KEY_CHARS = 64;

/** More blocks than any document has eligible children; a rogue-message bound. */
export const MAX_REQUEST_BLOCKS = 20000;

export const REQUEST_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** F3 — the playback rate range. */
export const SPEED_MIN = 0.25;
export const SPEED_MAX = 4;

/** F3 — the control panel's volume range, as `HTMLMediaElement.volume`. */
export const VOLUME_MIN = 0;
export const VOLUME_MAX = 1;

/**
 * F4 — the four highlight palettes. Same list as `HIGHLIGHT_THEMES` in
 * media/read-aloud-core.js; the colours live in media/read-aloud.css.
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

/**
 * One block of a continuous read (F15, decision 5): the half-open range
 * `[start, end)` of the request text that came from one eligible block, in
 * document order. The chunker never crosses one of these boundaries, and
 * every chunk reports which block it belongs to.
 */
export interface RequestBlock {
  key: string;
  start: number;
  end: number;
}

export interface SynthesizeOptions {
  kind: ReadAloudKind;
  blockId?: string;
  /** Absent for a selection or a single-unit read: the text is one block. */
  blocks?: RequestBlock[];
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
  /** Why the webview gave the job up; for the output channel only. */
  reason?: string;
}

/** A cancel reason is a short diagnostic string, never shown to the user. */
export const MAX_CANCEL_REASON_CHARS = 200;

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
  /** Index into the request's `blocks` (0 when the request had none). */
  blockIndex: number;
  audioBase64: string;
  mimeType: 'audio/mpeg';
  /** Offsets into the request text the webview sent. */
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
  /** F3 — the control panel's volume, 0 to 1. */
  volume: number;
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

function isIndex(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/**
 * `options.blocks`: an array of `{ key, start, end }` with non-empty,
 * ascending, non-overlapping ranges inside `[0, textLength]`. `undefined`
 * when the field is absent; `null` when it is present but malformed.
 */
function parseBlocks(
  value: unknown,
  textLength: number,
): RequestBlock[] | null | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Array.isArray(value) || value.length > MAX_REQUEST_BLOCKS) {
    return null;
  }
  const blocks: RequestBlock[] = [];
  let cursor = 0;
  for (const raw of value as unknown[]) {
    if (!isPlainObject(raw)) {
      return null;
    }
    const { key, start, end } = raw;
    if (typeof key !== 'string' || key.length > MAX_BLOCK_KEY_CHARS) {
      return null;
    }
    if (!isIndex(start) || !isIndex(end)) {
      return null;
    }
    if (start < cursor || end <= start || end > textLength) {
      return null;
    }
    blocks.push({ key, start, end });
    cursor = end;
  }
  return blocks;
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
  const blocks = parseBlocks(rawOptions.blocks, text.length);
  if (blocks === null) {
    return undefined;
  }
  if (blocks !== undefined && blocks.length > 0) {
    options.blocks = blocks;
  }
  return { sourceUri, requestId, text, options };
}

/** `readAloudCancel` -> `[sourceUri, requestId, reason?]` (F13). */
export function parseCancelArgs(args: unknown): CancelRequest | undefined {
  if (!Array.isArray(args) || args.length < 2 || args.length > 3) {
    return undefined;
  }
  const [sourceUri, requestId, rawReason] = args as unknown[];
  if (typeof sourceUri !== 'string' || sourceUri.length === 0) {
    return undefined;
  }
  if (typeof requestId !== 'string' || !REQUEST_ID_RE.test(requestId)) {
    return undefined;
  }
  const request: CancelRequest = { sourceUri, requestId };
  if (rawReason !== undefined && rawReason !== null) {
    if (typeof rawReason !== 'string') {
      return undefined;
    }
    request.reason = rawReason
      .slice(0, MAX_CANCEL_REASON_CHARS)
      .replace(/[\r\n]+/g, ' ');
  }
  return request;
}

/**
 * `readAloudPlaying` -> `[sourceUri, requestId, chunkIndex]`: the prefetch
 * window (F11) advances from the chunk the webview reports playing. A
 * non-integer or negative index is dropped.
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
  if (!isIndex(chunkIndex)) {
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

/**
 * `readAloudSetVolume` -> `[level]` (F13), the mirror of `readAloudSetSpeed`:
 * out of range is rejected, not clamped, because the panel's slider only ever
 * offers 0 to 1.
 */
export function parseSetVolumeArgs(args: unknown): number | undefined {
  if (!Array.isArray(args) || args.length !== 1) {
    return undefined;
  }
  const level = args[0] as unknown;
  if (typeof level !== 'number' || !Number.isFinite(level)) {
    return undefined;
  }
  if (level < VOLUME_MIN || level > VOLUME_MAX) {
    return undefined;
  }
  return level;
}

/** Clamp a volume read from the settings file, which the user can edit freely. */
export function clampVolume(level: number): number {
  if (typeof level !== 'number' || !Number.isFinite(level)) {
    return 1;
  }
  return Math.min(VOLUME_MAX, Math.max(VOLUME_MIN, level));
}
