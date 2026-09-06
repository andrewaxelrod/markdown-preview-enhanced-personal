import { CLASSROOM_CAPS } from '../classroom/plan-prompt';
import type { ModuleStatus, ModuleSummary } from '../classroom/module-format';
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
 * F4 — the five highlight palettes. Same list as `HIGHLIGHT_THEMES` in
 * media/read-aloud-core.js; the colours live in media/read-aloud.css.
 */
export const HIGHLIGHT_THEMES = [
  'blue',
  'pink',
  'red',
  'green',
  'orange',
] as const;
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

/**
 * The player font of the theme settings sheet: an override for the preview
 * theme's own family. Same ids as `PLAYER_FONTS` in
 * media/read-aloud-core.js, which is where the font stacks live — the host
 * only ever carries the id, so nothing the webview sends can turn into a
 * font-family declaration here.
 */
export const PLAYER_FONTS = [
  'default',
  'system',
  'helvetica',
  'verdana',
  'trebuchet',
  'georgia',
  'palatino',
  'baskerville',
  'times',
  'menlo',
] as const;
export type ReadAloudFont = (typeof PLAYER_FONTS)[number];
export const DEFAULT_PLAYER_FONT: ReadAloudFont = 'default';

export function normalisePlayerFont(value: unknown): ReadAloudFont {
  return typeof value === 'string' &&
    (PLAYER_FONTS as readonly string[]).includes(value)
    ? (value as ReadAloudFont)
    : DEFAULT_PLAYER_FONT;
}

/**
 * The low-strain reading page (`featrues/05-eye-strain.spec.md` §4): the
 * Global theme of the theme settings sheet. `off` is a Settings-only value
 * that restores the preview theme exactly as it was before the page existed
 * (D2). The webview mirrors the normalisers in media/read-aloud-core.js.
 */
export const GLOBAL_THEMES = ['auto', 'light', 'dark', 'off'] as const;
export type ReadAloudGlobalTheme = (typeof GLOBAL_THEMES)[number];
export const DEFAULT_GLOBAL_THEME: ReadAloudGlobalTheme = 'auto';

export function normaliseGlobalTheme(value: unknown): ReadAloudGlobalTheme {
  return typeof value === 'string' &&
    (GLOBAL_THEMES as readonly string[]).includes(value)
    ? (value as ReadAloudGlobalTheme)
    : DEFAULT_GLOBAL_THEME;
}

/**
 * Eye strain 2 (`featrues/07-eye-strain-2/spec.md` §5.1): the one text-size
 * slider of the theme settings sheet, in px, 16–28, default 20. The line
 * height, the heading sizes and the reading column derive from it in the
 * webview; the host only stores the integer.
 */
export const TEXT_SIZE_MIN = 16;
export const TEXT_SIZE_MAX = 28;
export const TEXT_SIZE_STEP = 1;
export const DEFAULT_TEXT_SIZE = 20;

/** Whole pixels, clamped; anything that is not a finite number is the default. */
export function clampTextSize(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_TEXT_SIZE;
  }
  return Math.min(TEXT_SIZE_MAX, Math.max(TEXT_SIZE_MIN, Math.round(value)));
}

/**
 * 07 §9.1: how the spoken word is marked — an underline sweep in the
 * palette's stroke colour, the filled box, or nothing. Same list as
 * `WORD_MARKERS` in media/read-aloud-core.js.
 */
export const WORD_MARKERS = ['underline', 'box', 'off'] as const;
export type ReadAloudWordMarker = (typeof WORD_MARKERS)[number];
export const DEFAULT_WORD_MARKER: ReadAloudWordMarker = 'underline';

export function normaliseWordMarker(value: unknown): ReadAloudWordMarker {
  return typeof value === 'string' &&
    (WORD_MARKERS as readonly string[]).includes(value)
    ? (value as ReadAloudWordMarker)
    : DEFAULT_WORD_MARKER;
}

/**
 * `help` is the help sheet's own read (`featrues/04-help-module.md` §5): a
 * bounded multi-block read, like a selection, whose scope is the sheet body
 * rather than the preview root.
 */
export type ReadAloudKind = 'block' | 'selection' | 'help' | 'note';

/** The kinds `readAloudSynthesize` accepts; `note` is the Note sheet's read (12 §11.5). */
export const READ_ALOUD_KINDS: readonly ReadAloudKind[] = [
  'block',
  'selection',
  'help',
  'note',
];

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
  /** Theme settings — the preview font override, by id. */
  font: ReadAloudFont;
  /** The low-strain page (05 §10.2): the Global theme. */
  globalTheme: ReadAloudGlobalTheme;
  /** Eye strain 2 (07 §15.2): the text size in px, 16–28. */
  textSize: number;
  /** 07 §9: `underline` · `box` · `off`. */
  wordMarker: ReadAloudWordMarker;
  /** 07 §8.5: dim every readable block but the one being read. */
  dimWhileReading: boolean;
  /** 07 §10: fade the panel after a few idle seconds of playback. */
  panelAutoHide: boolean;
  /** Help (§7): false in the web build, where no process can be spawned. */
  helpAvailable: boolean;
  /** The sheet's own label, e.g. `claude · sonnet · low` (§4 step 2). */
  helpEngine: string;
  helpModel: string;
  helpEffort: string;
  /** D2 — read the explanation as soon as it arrives. */
  helpAutoPlay: boolean;
  /** Notes (12 §14.3): desktop and `notesEnabled`. */
  notesAvailable: boolean;
  /** 12 §10.1 — what the document shows for a note. */
  notesDecoration: NotesDecoration;
  /** Classroom (13 §14.3): desktop and `classroomEnabled`. */
  classroomAvailable: boolean;
  /**
   * 13 §12.2 — present (or null) in the config of a module preview; absent
   * from a broadcast, which leaves the webview's value alone.
   */
  classroomModule?: ClassroomModuleConfig | null;
}

export type ReadAloudControlAction =
  | 'stop'
  | 'togglePlayPause'
  | 'readSelection'
  /** §2 — `Alt+H` and the `readAloud.help` command. */
  | 'help'
  /** 12 §5.1 — `Alt+N` and the `notes.create` command. */
  | 'note'
  /** 12 §12 — `Alt+Shift+N` and the `notes.showList` command. */
  | 'notesList'
  /** 12 §13.1 — _Reveal in preview_ from the Notes view; carries `noteId`. */
  | 'showNote'
  /** 13 §5.1 — `Alt+C` and the `readAloud.classroom` command. */
  | 'classroom'
  /** 13 §12.2 — `Alt+Shift+C` and the `readAloud.classroomModule` command. */
  | 'classroomModule'
  /** 13 §12.4 — _Open the source passage_; carries `anchor` and `moduleId`. */
  | 'revealAnchor';

export interface ReadAloudControlMessage {
  command: 'readAloudControl';
  action: ReadAloudControlAction;
  noteId?: string;
  anchor?: NoteAnchorPayload;
  moduleId?: string;
}

/** §9 — the rendered explanation, plus the markdown a follow-up sends back. */
export interface ReadAloudHelpResultMessage {
  command: 'readAloudHelpResult';
  requestId: string;
  html: string;
  markdown: string;
  engine: string;
  model: string;
  effort: string;
  cached: boolean;
  durationMs: number;
}

export interface ReadAloudHelpErrorMessage {
  command: 'readAloudHelpError';
  requestId: string;
  message: string;
  retryable: boolean;
}

export type HostToWebviewMessage =
  | ReadAloudAudioMessage
  | ReadAloudErrorMessage
  | ReadAloudConfigMessage
  | ReadAloudControlMessage
  | ReadAloudHelpResultMessage
  | ReadAloudHelpErrorMessage
  | ReadAloudNotesMessage
  | ReadAloudNoteErrorMessage
  | ReadAloudClassroomPreparedMessage
  | ReadAloudClassroomProgressMessage
  | ReadAloudClassroomErrorMessage;

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
  if (
    typeof kind !== 'string' ||
    !(READ_ALOUD_KINDS as readonly string[]).includes(kind)
  ) {
    return undefined;
  }
  const options: SynthesizeOptions = { kind: kind as ReadAloudKind };
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

/**
 * `readAloudSetHighlightTheme` -> `[theme]` (F13), from a swatch of the theme
 * settings sheet. An unknown palette is rejected, not defaulted: the sheet
 * only ever offers the five, so anything else is a rogue message.
 */
export function parseSetHighlightThemeArgs(
  args: unknown,
): ReadAloudHighlightTheme | undefined {
  if (!Array.isArray(args) || args.length !== 1) {
    return undefined;
  }
  const theme = args[0] as unknown;
  return typeof theme === 'string' &&
    (HIGHLIGHT_THEMES as readonly string[]).includes(theme)
    ? (theme as ReadAloudHighlightTheme)
    : undefined;
}

// ---------------------------------------------------------------------------
// Help (`featrues/04-help-module.md` §9)
//
// The webview assembles every field from the DOM it already extracts for
// reading, so what the model sees is what the listener heard; the host
// validates every field and every cap of §3.1 here before the engine sees it.
// This is the first read-aloud message that carries document text off the
// machine (§10), which is why nothing beyond the exact shape gets through.
// ---------------------------------------------------------------------------

export const HELP_FIELD_CAPS = {
  title: 200,
  breadcrumbLevels: 6,
  breadcrumbLevel: 200,
  before: 1500,
  passage: 6000,
  after: 1500,
  /**
   * Deliberately four times the 6,000-character *prompt* cap of §3.1. This is
   * a bound on a rogue message, not the prompt's budget: §14.2 trims the
   * section evenly around its `[PASSAGE]` marker, and truncating from the
   * front here would throw that marker away before `trimAroundPassage` in
   * `help-prompt.ts` ever saw it.
   */
  section: 24000,
  /**
   * 11 help fixes — the block the passage was taken from, with the passage
   * marked, and the document's other mentions of a short passage. Like
   * `section`, `enclosing` is four times its prompt cap so the ⟦ marker
   * survives to the trim in `help-prompt.ts`; `mentions` is cut from the
   * front there, so its bound is simply looser than the prompt's.
   */
  enclosing: 12000,
  mentions: 4000,
  question: 500,
  previous: 6000,
} as const;

export const HELP_CONTEXT_MODES = ['selection', 'section', 'document'] as const;
export type HelpContextMode = (typeof HELP_CONTEXT_MODES)[number];

/**
 * §8 — which follow-up this is. The three chips carry a *kind*, not their
 * instruction text: §14.4 fixes that text in `help-prompt.ts` as the single
 * copy the implementation uses, and each chip has its own word target (§3.3),
 * which the host could not recover from free text. `question` is the typed
 * box, and is the only kind that also carries `question` text.
 */
export const HELP_FOLLOW_UPS = [
  'simpler',
  'deeper',
  'example',
  'question',
] as const;
export type HelpFollowUp = (typeof HELP_FOLLOW_UPS)[number];

export interface HelpRequest {
  sourceUri: string;
  requestId: string;
  passage: string;
  title: string;
  breadcrumb: string[];
  before: string;
  after: string;
  section: string;
  /** The passage's own block(s) with the passage marked, or '' (11). */
  enclosing: string;
  /** The document's other uses of a short passage, or '' (11). */
  mentions: string;
  contextMode: HelpContextMode;
  followUp?: HelpFollowUp;
  question?: string;
  previous?: string;
}

/** A capped, newline-normalised string, or `undefined` when it is not one. */
function capped(value: unknown, limit: number): string | undefined {
  if (value === undefined || value === null) {
    return '';
  }
  if (typeof value !== 'string') {
    return undefined;
  }
  return value.replace(/\r\n?/g, '\n').slice(0, limit);
}

/** The help material the webview assembles (§3.1), without the passage. */
export interface HelpFieldsPayload {
  title: string;
  breadcrumb: string[];
  before: string;
  after: string;
  section: string;
  enclosing: string;
  mentions: string;
  contextMode: HelpContextMode;
}

/** A breadcrumb: at most six string levels, each capped; `undefined` when malformed. */
function parseBreadcrumb(raw: unknown): string[] | undefined {
  const breadcrumb: string[] = [];
  if (raw === undefined || raw === null) {
    return breadcrumb;
  }
  if (!Array.isArray(raw)) {
    return undefined;
  }
  for (const level of raw as unknown[]) {
    if (typeof level !== 'string') {
      return undefined;
    }
    if (breadcrumb.length >= HELP_FIELD_CAPS.breadcrumbLevels) {
      break;
    }
    breadcrumb.push(level.slice(0, HELP_FIELD_CAPS.breadcrumbLevel));
  }
  return breadcrumb;
}

/**
 * The fields object of `readAloudHelp`, `readAloudNoteCreate` and
 * `readAloudNoteRegenerate` (12 §14.2): the same caps, the same refusals.
 */
export function parseHelpFieldsObject(
  rawFields: Record<string, unknown>,
): HelpFieldsPayload | undefined {
  const contextMode = rawFields.contextMode;
  if (
    typeof contextMode !== 'string' ||
    !(HELP_CONTEXT_MODES as readonly string[]).includes(contextMode)
  ) {
    return undefined;
  }
  const title = capped(rawFields.title, HELP_FIELD_CAPS.title);
  const before = capped(rawFields.before, HELP_FIELD_CAPS.before);
  const after = capped(rawFields.after, HELP_FIELD_CAPS.after);
  const section = capped(rawFields.section, HELP_FIELD_CAPS.section);
  const enclosing = capped(rawFields.enclosing, HELP_FIELD_CAPS.enclosing);
  const mentions = capped(rawFields.mentions, HELP_FIELD_CAPS.mentions);
  if (
    title === undefined ||
    before === undefined ||
    after === undefined ||
    section === undefined ||
    enclosing === undefined ||
    mentions === undefined
  ) {
    return undefined;
  }
  const breadcrumb = parseBreadcrumb(rawFields.breadcrumb);
  if (!breadcrumb) {
    return undefined;
  }
  return {
    title,
    breadcrumb,
    before,
    after,
    section,
    enclosing,
    mentions,
    contextMode: contextMode as HelpContextMode,
  };
}

/**
 * `readAloudHelp` -> `[sourceUri, requestId, passage, fields]` (§9).
 *
 * The passage must be non-empty: there is nothing to explain otherwise, and
 * the button is disabled in that state. Every other field may be empty, and
 * over-long fields are truncated rather than rejected, because they are
 * assembled from the document rather than typed: a long section is the normal
 * case, not a rogue message.
 */
export function parseHelpArgs(args: unknown): HelpRequest | undefined {
  if (!Array.isArray(args) || args.length !== 4) {
    return undefined;
  }
  const [sourceUri, requestId, rawPassage, rawFields] = args as unknown[];
  if (typeof sourceUri !== 'string' || sourceUri.length === 0) {
    return undefined;
  }
  if (typeof requestId !== 'string' || !REQUEST_ID_RE.test(requestId)) {
    return undefined;
  }
  const passage = capped(rawPassage, HELP_FIELD_CAPS.passage);
  if (passage === undefined || passage.trim().length === 0) {
    return undefined;
  }
  if (!isPlainObject(rawFields)) {
    return undefined;
  }
  const fields = parseHelpFieldsObject(rawFields);
  if (!fields) {
    return undefined;
  }

  const request: HelpRequest = {
    sourceUri,
    requestId,
    passage,
    ...fields,
  };

  const followUp = rawFields.followUp;
  if (followUp !== undefined && followUp !== null) {
    if (
      typeof followUp !== 'string' ||
      !(HELP_FOLLOW_UPS as readonly string[]).includes(followUp)
    ) {
      return undefined;
    }
    request.followUp = followUp as HelpFollowUp;
  }

  const question = capped(rawFields.question, HELP_FIELD_CAPS.question);
  if (question === undefined) {
    return undefined;
  }
  if (question) {
    request.question = question;
  }

  const previous = capped(rawFields.previous, HELP_FIELD_CAPS.previous);
  if (previous === undefined) {
    return undefined;
  }
  if (previous) {
    request.previous = previous;
  }

  // A follow-up without the explanation it follows is a bug in the webview,
  // not a request: the model would be told to go deeper on nothing.
  if (request.followUp && !request.previous) {
    return undefined;
  }
  if (request.followUp === 'question' && !request.question) {
    return undefined;
  }
  return request;
}

/** `readAloudHelpCancel` -> `[sourceUri, requestId, reason?]` (§9). */
export function parseHelpCancelArgs(args: unknown): CancelRequest | undefined {
  return parseCancelArgs(args);
}

/** `readAloudSetFont` -> `[font]` (F13), the mirror of the theme above. */
export function parseSetFontArgs(args: unknown): ReadAloudFont | undefined {
  if (!Array.isArray(args) || args.length !== 1) {
    return undefined;
  }
  const font = args[0] as unknown;
  return typeof font === 'string' &&
    (PLAYER_FONTS as readonly string[]).includes(font)
    ? (font as ReadAloudFont)
    : undefined;
}

/**
 * `readAloudSetGlobalTheme` -> `[theme]` (05 §10.2): a segment of the
 * Global theme control. `off` is accepted too, so a Settings value can be
 * echoed back, though the sheet itself never sends it.
 */
export function parseSetGlobalThemeArgs(
  args: unknown,
): ReadAloudGlobalTheme | undefined {
  if (!Array.isArray(args) || args.length !== 1) {
    return undefined;
  }
  const theme = args[0] as unknown;
  return typeof theme === 'string' &&
    (GLOBAL_THEMES as readonly string[]).includes(theme)
    ? (theme as ReadAloudGlobalTheme)
    : undefined;
}

/**
 * `readAloudSetTextSize` -> `[value]` (07 §15.2): one finite number, rounded
 * and clamped to 16–28. Out of range is clamped rather than dropped — the
 * host stores an integer, never a string, so nothing the webview sends can
 * become CSS here.
 */
export function parseSetTextSizeArgs(args: unknown): number | undefined {
  if (!Array.isArray(args) || args.length !== 1) {
    return undefined;
  }
  const value = args[0] as unknown;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }
  return clampTextSize(value);
}

/**
 * `readAloudSetWordMarker` -> `[style]` (07 §15.2): one string of the enum.
 * An unknown style is rejected, not defaulted: the sheet only ever offers
 * the three, so anything else is a rogue message.
 */
export function parseSetWordMarkerArgs(
  args: unknown,
): ReadAloudWordMarker | undefined {
  if (!Array.isArray(args) || args.length !== 1) {
    return undefined;
  }
  const style = args[0] as unknown;
  return typeof style === 'string' &&
    (WORD_MARKERS as readonly string[]).includes(style)
    ? (style as ReadAloudWordMarker)
    : undefined;
}

/** `readAloudResetPage` -> `[]` (05 §9.4): the Reset page settings button. */
export function parseResetPageArgs(args: unknown): boolean {
  return Array.isArray(args) && args.length === 0;
}

// ---------------------------------------------------------------------------
// Notes (`featrues/12-notes/spec.md` §14)
//
// Ten webview -> host messages, every one parsed here before the notes
// controller sees it, and the two host -> webview shapes. The note id and the
// block key have fixed shapes; every free string has a cap; tags are
// normalised on the host (§14.2).
// ---------------------------------------------------------------------------

export const NOTES_DECORATIONS = ['marker-and-mark', 'marker', 'none'] as const;
export type NotesDecoration = (typeof NOTES_DECORATIONS)[number];
export const DEFAULT_NOTES_DECORATION: NotesDecoration = 'marker-and-mark';

export function normaliseNotesDecoration(value: unknown): NotesDecoration {
  return typeof value === 'string' &&
    (NOTES_DECORATIONS as readonly string[]).includes(value)
    ? (value as NotesDecoration)
    : DEFAULT_NOTES_DECORATION;
}

export const NOTE_ID_RE = /^\d{8}T\d{6}Z-[0-9a-f]{4}$/;
export const NOTE_BLOCK_KEY_RE = /^b[0-9a-f]{1,8}$/;
export const NOTE_TAG_RE = /^[a-z0-9][a-z0-9-]*$/;

export const NOTE_CAPS = {
  exact: 6000,
  prefix: 64,
  suffix: 64,
  blocks: 50,
  title: 120,
  myNote: 20000,
  tags: 12,
  tag: 32,
  anchors: 500,
  /** `options.explanation` of _Save as note_: the sheet's own answer cap. */
  explanation: 40000,
} as const;

export type NoteSource = 'selection' | 'help';
export type NoteOpenTarget = 'editor' | 'file';

/** 12 §9.1 — the anchor the webview computes from the resolved selection. */
export interface NoteAnchorPayload {
  block: string;
  line: number | null;
  exact: string;
  prefix: string;
  suffix: string;
  offset: number;
  blocks: number;
}

export interface NoteCreateRequest {
  sourceUri: string;
  requestId: string;
  passage: string;
  fields: HelpFieldsPayload;
  anchor: NoteAnchorPayload;
  source: NoteSource;
  /** `source: 'help'` — the markdown of the explanation on screen (§5.4). */
  explanation?: string;
}

export interface NoteUpdateRequest {
  sourceUri: string;
  noteId: string;
  title?: string;
  myNote?: string;
  tags?: string[];
}

export interface NoteIdRequest {
  sourceUri: string;
  noteId: string;
}

export interface NoteRegenerateRequest {
  sourceUri: string;
  noteId: string;
  /** Fresh material against the anchored block, or null for the stored context. */
  fields: HelpFieldsPayload | null;
}

export interface NoteReattachRequest {
  sourceUri: string;
  noteId: string;
  anchor: NoteAnchorPayload;
  breadcrumb: string[];
}

export interface NoteOpenRequest {
  sourceUri: string;
  noteId: string;
  target: NoteOpenTarget;
}

export interface NoteAnchorReport {
  noteId: string;
  found: boolean;
  block?: string;
  line?: number | null;
}

export interface NoteAnchorsRequest {
  sourceUri: string;
  anchors: NoteAnchorReport[];
}

/** 12 §14.3 — one note as the webview sees it. */
export interface NoteSummary {
  id: string;
  title: string;
  titleEdited: boolean;
  shape: 'passage' | 'term';
  created: string;
  updated: string;
  headings: string[];
  passage: string;
  anchor: NoteAnchorPayload & {
    lastSeen?: string;
    missingSince?: string;
    current?: { block: string; line: number | null };
  };
  generated: {
    status: 'pending' | 'done' | 'error';
    source?: 'engine' | 'help';
    engine?: string;
    model?: string;
    effort?: string;
    at?: string;
    error?: string;
  };
  tags: string[];
  myNote: string;
  /** The generated sections rendered by the host, after sanitising. */
  html: string;
  sectionsMarkdown: string;
  /** Which generated sections are present, in the file's order. */
  sectionNames: string[];
  context: { enclosing: string; before: string; after: string };
  summaryLine: string;
}

export interface ReadAloudNotesMessage {
  command: 'readAloudNotes';
  sourceUri: string;
  notes: NoteSummary[];
  deleting: string[];
  /** Whether a delete ends in the OS trash or is permanent (§7.7). */
  deleteMode: 'trash' | 'permanent';
  /** `notesGenerate` at the time of posting, for the generation-off state. */
  generate: boolean;
}

export interface ReadAloudNoteErrorMessage {
  command: 'readAloudNoteError';
  noteId?: string;
  requestId?: string;
  message: string;
}

function isSourceUri(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isNoteId(value: unknown): value is string {
  return typeof value === 'string' && NOTE_ID_RE.test(value);
}

/** 12 §14.2 — the anchor object, every field checked; `undefined` when malformed. */
export function parseNoteAnchor(raw: unknown): NoteAnchorPayload | undefined {
  if (!isPlainObject(raw)) {
    return undefined;
  }
  const { block, line, exact, prefix, suffix, offset, blocks } = raw;
  if (typeof block !== 'string' || !NOTE_BLOCK_KEY_RE.test(block)) {
    return undefined;
  }
  if (line !== null && line !== undefined && !isIndex(line)) {
    return undefined;
  }
  if (typeof exact !== 'string' || exact.length > NOTE_CAPS.exact) {
    return undefined;
  }
  if (
    (prefix !== undefined && typeof prefix !== 'string') ||
    (suffix !== undefined && typeof suffix !== 'string')
  ) {
    return undefined;
  }
  if (
    (typeof prefix === 'string' && prefix.length > NOTE_CAPS.prefix) ||
    (typeof suffix === 'string' && suffix.length > NOTE_CAPS.suffix)
  ) {
    return undefined;
  }
  if (!isIndex(offset)) {
    return undefined;
  }
  const blockCount = blocks === undefined ? 1 : blocks;
  if (!isIndex(blockCount) || blockCount < 1 || blockCount > NOTE_CAPS.blocks) {
    return undefined;
  }
  return {
    block,
    line: line === undefined ? null : (line as number | null),
    exact: exact.replace(/\r\n?/g, '\n'),
    prefix: typeof prefix === 'string' ? prefix : '',
    suffix: typeof suffix === 'string' ? suffix : '',
    offset,
    blocks: blockCount,
  };
}

/**
 * One tag as the host stores it: lower-cased, spaces to hyphens, anything
 * outside `[a-z0-9-]` dropped, capped; `null` when nothing is left.
 */
export function normaliseNoteTag(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const tag = value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, NOTE_CAPS.tag);
  return tag && NOTE_TAG_RE.test(tag) ? tag : null;
}

/** At most twelve distinct tags; `undefined` when the value is not an array of strings. */
export function parseNoteTags(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const out: string[] = [];
  for (const raw of value as unknown[]) {
    if (typeof raw !== 'string') {
      return undefined;
    }
    const tag = normaliseNoteTag(raw);
    if (tag && !out.includes(tag)) {
      out.push(tag);
      if (out.length >= NOTE_CAPS.tags) {
        break;
      }
    }
  }
  return out;
}

/**
 * `readAloudNoteCreate` -> `[sourceUri, requestId, passage, fields, anchor,
 * options]` (12 §14.2). The passage must be non-empty; `options.source` is
 * `selection` or `help`, and `help` carries the explanation on screen.
 */
export function parseNoteCreateArgs(
  args: unknown,
): NoteCreateRequest | undefined {
  if (!Array.isArray(args) || args.length !== 6) {
    return undefined;
  }
  const [sourceUri, requestId, rawPassage, rawFields, rawAnchor, rawOptions] =
    args as unknown[];
  if (!isSourceUri(sourceUri)) {
    return undefined;
  }
  if (typeof requestId !== 'string' || !REQUEST_ID_RE.test(requestId)) {
    return undefined;
  }
  const passage = capped(rawPassage, HELP_FIELD_CAPS.passage);
  if (passage === undefined || passage.trim().length === 0) {
    return undefined;
  }
  if (!isPlainObject(rawFields)) {
    return undefined;
  }
  const fields = parseHelpFieldsObject(rawFields);
  if (!fields) {
    return undefined;
  }
  const anchor = parseNoteAnchor(rawAnchor);
  if (!anchor) {
    return undefined;
  }
  if (!isPlainObject(rawOptions)) {
    return undefined;
  }
  const source = rawOptions.source;
  if (source !== 'selection' && source !== 'help') {
    return undefined;
  }
  const request: NoteCreateRequest = {
    sourceUri,
    requestId,
    passage,
    fields,
    anchor,
    source,
  };
  if (source === 'help') {
    const explanation = capped(rawOptions.explanation, NOTE_CAPS.explanation);
    if (explanation === undefined || explanation.trim().length === 0) {
      return undefined;
    }
    request.explanation = explanation;
  } else if (
    rawOptions.explanation !== undefined &&
    rawOptions.explanation !== null
  ) {
    return undefined;
  }
  return request;
}

/**
 * `readAloudNoteUpdate` -> `[sourceUri, noteId, { title?, myNote?, tags? }]`.
 * At least one field must be present; each is capped and, for tags,
 * normalised. A title that normalises to nothing is rejected: the body's
 * `h1` is the single source of the title and must not go empty.
 */
export function parseNoteUpdateArgs(
  args: unknown,
): NoteUpdateRequest | undefined {
  if (!Array.isArray(args) || args.length !== 3) {
    return undefined;
  }
  const [sourceUri, noteId, rawPatch] = args as unknown[];
  if (!isSourceUri(sourceUri) || !isNoteId(noteId)) {
    return undefined;
  }
  if (!isPlainObject(rawPatch)) {
    return undefined;
  }
  const request: NoteUpdateRequest = { sourceUri, noteId };
  let any = false;
  if (rawPatch.title !== undefined) {
    if (typeof rawPatch.title !== 'string') {
      return undefined;
    }
    const title = rawPatch.title.replace(/\s+/g, ' ').trim();
    if (!title) {
      return undefined;
    }
    request.title = title.slice(0, NOTE_CAPS.title);
    any = true;
  }
  if (rawPatch.myNote !== undefined) {
    if (typeof rawPatch.myNote !== 'string') {
      return undefined;
    }
    request.myNote = rawPatch.myNote
      .replace(/\r\n?/g, '\n')
      .slice(0, NOTE_CAPS.myNote);
    any = true;
  }
  if (rawPatch.tags !== undefined) {
    const tags = parseNoteTags(rawPatch.tags);
    if (!tags) {
      return undefined;
    }
    request.tags = tags;
    any = true;
  }
  return any ? request : undefined;
}

function parseNoteIdArgs(args: unknown): NoteIdRequest | undefined {
  if (!Array.isArray(args) || args.length !== 2) {
    return undefined;
  }
  const [sourceUri, noteId] = args as unknown[];
  if (!isSourceUri(sourceUri) || !isNoteId(noteId)) {
    return undefined;
  }
  return { sourceUri, noteId };
}

/** `readAloudNoteDelete` -> `[sourceUri, noteId]`. */
export function parseNoteDeleteArgs(args: unknown): NoteIdRequest | undefined {
  return parseNoteIdArgs(args);
}

/** `readAloudNoteUndoDelete` -> `[sourceUri, noteId]`. */
export function parseNoteUndoDeleteArgs(
  args: unknown,
): NoteIdRequest | undefined {
  return parseNoteIdArgs(args);
}

/** `readAloudNoteCopy` -> `[sourceUri, noteId]`. */
export function parseNoteCopyArgs(args: unknown): NoteIdRequest | undefined {
  return parseNoteIdArgs(args);
}

/**
 * `readAloudNoteRegenerate` -> `[sourceUri, noteId, fields | null]`: fresh
 * material when the note is anchored, `null` for the stored context (§8.4).
 */
export function parseNoteRegenerateArgs(
  args: unknown,
): NoteRegenerateRequest | undefined {
  if (!Array.isArray(args) || args.length !== 3) {
    return undefined;
  }
  const [sourceUri, noteId, rawFields] = args as unknown[];
  if (!isSourceUri(sourceUri) || !isNoteId(noteId)) {
    return undefined;
  }
  if (rawFields === null || rawFields === undefined) {
    return { sourceUri, noteId, fields: null };
  }
  if (!isPlainObject(rawFields)) {
    return undefined;
  }
  const fields = parseHelpFieldsObject(rawFields);
  if (!fields) {
    return undefined;
  }
  return { sourceUri, noteId, fields };
}

/** `readAloudNoteReattach` -> `[sourceUri, noteId, anchor, breadcrumb]` (§11.3). */
export function parseNoteReattachArgs(
  args: unknown,
): NoteReattachRequest | undefined {
  if (!Array.isArray(args) || args.length !== 4) {
    return undefined;
  }
  const [sourceUri, noteId, rawAnchor, rawBreadcrumb] = args as unknown[];
  if (!isSourceUri(sourceUri) || !isNoteId(noteId)) {
    return undefined;
  }
  const anchor = parseNoteAnchor(rawAnchor);
  if (!anchor) {
    return undefined;
  }
  const breadcrumb = parseBreadcrumb(rawBreadcrumb);
  if (!breadcrumb) {
    return undefined;
  }
  return { sourceUri, noteId, anchor, breadcrumb };
}

/** `readAloudNoteOpen` -> `[sourceUri, noteId, 'editor' | 'file']` (§11.4). */
export function parseNoteOpenArgs(args: unknown): NoteOpenRequest | undefined {
  if (!Array.isArray(args) || args.length !== 3) {
    return undefined;
  }
  const [sourceUri, noteId, target] = args as unknown[];
  if (!isSourceUri(sourceUri) || !isNoteId(noteId)) {
    return undefined;
  }
  if (target !== 'editor' && target !== 'file') {
    return undefined;
  }
  return { sourceUri, noteId, target };
}

/**
 * `readAloudNoteAnchors` -> `[sourceUri, [{ noteId, found, block?, line? }]]`
 * (§9.4), at most 500 entries. A found note may say where; a missing one
 * carries nothing else.
 */
export function parseNoteAnchorsArgs(
  args: unknown,
): NoteAnchorsRequest | undefined {
  if (!Array.isArray(args) || args.length !== 2) {
    return undefined;
  }
  const [sourceUri, rawList] = args as unknown[];
  if (!isSourceUri(sourceUri)) {
    return undefined;
  }
  if (!Array.isArray(rawList) || rawList.length > NOTE_CAPS.anchors) {
    return undefined;
  }
  const anchors: NoteAnchorReport[] = [];
  const seen = new Set<string>();
  for (const raw of rawList as unknown[]) {
    if (!isPlainObject(raw) || !isNoteId(raw.noteId)) {
      return undefined;
    }
    if (typeof raw.found !== 'boolean') {
      return undefined;
    }
    if (seen.has(raw.noteId)) {
      return undefined;
    }
    seen.add(raw.noteId);
    const report: NoteAnchorReport = { noteId: raw.noteId, found: raw.found };
    if (raw.block !== undefined && raw.block !== null) {
      if (typeof raw.block !== 'string' || !NOTE_BLOCK_KEY_RE.test(raw.block)) {
        return undefined;
      }
      report.block = raw.block;
    }
    if (raw.line !== undefined) {
      if (raw.line !== null && !isIndex(raw.line)) {
        return undefined;
      }
      report.line = raw.line as number | null;
    }
    anchors.push(report);
  }
  return { sourceUri, anchors };
}

/** `readAloudNotesShowAll` -> `[sourceUri]` (§12). */
export function parseNotesShowAllArgs(args: unknown): string | undefined {
  if (!Array.isArray(args) || args.length !== 1) {
    return undefined;
  }
  return isSourceUri(args[0]) ? args[0] : undefined;
}

// ---------------------------------------------------------------------------
// Classroom (`featrues/13-classroom/spec.md` §14)
//
// Seven webview -> host messages, every one parsed here before the classroom
// controller sees it, and the three host -> webview shapes. The passage and
// the fields take help's caps; the anchor the notes'; the level is 1–3; the
// linked paths are workspace-relative, short, and never climb.
// ---------------------------------------------------------------------------

export const CLASSROOM_PERSONA_ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

export type ClassroomLevelValue = 1 | 2 | 3;

export interface ClassroomPrepareRequest {
  sourceUri: string;
  requestId: string;
  fields: HelpFieldsPayload;
}

export interface ClassroomBuildRequest {
  sourceUri: string;
  requestId: string;
  passage: string;
  fields: HelpFieldsPayload;
  anchor: NoteAnchorPayload;
  level: ClassroomLevelValue;
  readerNote: string;
  persona: string;
  audience: string;
  /** Workspace-relative paths the reader left ticked; re-resolved by the host. */
  linked: string[];
  headingId: string | null;
}

export interface ClassroomCancelRequest {
  sourceUri: string;
  moduleId: string;
  reason: string;
}

export interface ClassroomModuleRequest {
  sourceUri: string;
  moduleId: string;
}

export interface ClassroomOpenSourceRequest {
  moduleUri: string;
  moduleId: string;
}

/** 13 §12.2 — what a module preview's config carries. */
export interface ClassroomModuleConfig {
  id: string;
  title: string;
  status: ModuleStatus;
  chapters: ClassroomChapterState[];
  documentTitle: string;
  documentPath: string;
  /** The passage's nearest heading, for the Module sheet's _From_ line. */
  documentHeading: string;
}

export interface ClassroomChapterState {
  n: number;
  title: string;
  status: 'queued' | 'writing' | 'done' | 'failed';
  flagged: string[];
}

/** 13 §14.3 — the whole build state, every time; the webview diffs nothing. */
export interface ClassroomProgress {
  moduleId: string;
  documentUri: string;
  moduleUri: string;
  status: ModuleStatus;
  title: string;
  /** The chapter being written (1-based), or 0 while planning or when done. */
  chapter: number;
  of: number;
  chapterTitle: string;
  chapters: ClassroomChapterState[];
  elapsedMs: number;
  words: number;
  queuePosition: number;
  error: string | null;
  /** Whether a chapter is on disk, so Open has somewhere to go. */
  hasChapter: boolean;
}

export interface ReadAloudClassroomPreparedMessage {
  command: 'readAloudClassroomPrepared';
  requestId: string;
  persona: { id: string; name: string; tagline: string };
  personas: { id: string; name: string; tagline: string }[];
  audience: string;
  documentWords: number;
  linked: { path: string; title: string; words: number }[];
  modules: ModuleSummary[];
  engine: { engine: string; model: string; effort: string };
  building: ClassroomProgress | null;
}

export interface ReadAloudClassroomProgressMessage extends ClassroomProgress {
  command: 'readAloudClassroomProgress';
}

export interface ReadAloudClassroomErrorMessage {
  command: 'readAloudClassroomError';
  requestId?: string;
  moduleId?: string;
  message: string;
  retryable: boolean;
}

/** `readAloudClassroomPrepare` -> `[sourceUri, requestId, fields]`. */
export function parseClassroomPrepareArgs(
  args: unknown,
): ClassroomPrepareRequest | undefined {
  if (!Array.isArray(args) || args.length !== 3) {
    return undefined;
  }
  const [sourceUri, requestId, rawFields] = args as unknown[];
  if (!isSourceUri(sourceUri)) {
    return undefined;
  }
  if (typeof requestId !== 'string' || !REQUEST_ID_RE.test(requestId)) {
    return undefined;
  }
  if (!isPlainObject(rawFields)) {
    return undefined;
  }
  const fields = parseHelpFieldsObject(rawFields);
  if (!fields) {
    return undefined;
  }
  return { sourceUri, requestId, fields };
}

/** A workspace-relative path: short, no `..` segment, not absolute, no scheme. */
export function isSafeRelativePath(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > CLASSROOM_CAPS.linkedPath
  ) {
    return false;
  }
  if (
    /^[\\/]/.test(value) ||
    /^[A-Za-z]:/.test(value) ||
    /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value)
  ) {
    return false;
  }
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f]/.test(value)) {
    return false;
  }
  return !value.split(/[\\/]/).some((segment) => segment === '..');
}

/**
 * `readAloudClassroomBuild` -> `[sourceUri, requestId, passage, fields,
 * anchor, { level, readerNote, persona, audience, linked, headingId }]`.
 * `readerNote` and `audience` may be empty strings; `linked` holds at most
 * four workspace-relative paths; `headingId` is a short id or null.
 */
export function parseClassroomBuildArgs(
  args: unknown,
): ClassroomBuildRequest | undefined {
  if (!Array.isArray(args) || args.length !== 6) {
    return undefined;
  }
  const [sourceUri, requestId, rawPassage, rawFields, rawAnchor, rawOptions] =
    args as unknown[];
  if (!isSourceUri(sourceUri)) {
    return undefined;
  }
  if (typeof requestId !== 'string' || !REQUEST_ID_RE.test(requestId)) {
    return undefined;
  }
  const passage = capped(rawPassage, HELP_FIELD_CAPS.passage);
  if (passage === undefined || passage.trim().length === 0) {
    return undefined;
  }
  if (!isPlainObject(rawFields)) {
    return undefined;
  }
  const fields = parseHelpFieldsObject(rawFields);
  if (!fields) {
    return undefined;
  }
  const anchor = parseNoteAnchor(rawAnchor);
  if (!anchor) {
    return undefined;
  }
  if (!isPlainObject(rawOptions)) {
    return undefined;
  }
  const level = rawOptions.level;
  if (level !== 1 && level !== 2 && level !== 3) {
    return undefined;
  }
  const readerNote = capped(rawOptions.readerNote, CLASSROOM_CAPS.readerNote);
  const audience = capped(rawOptions.audience, CLASSROOM_CAPS.audience);
  if (readerNote === undefined || audience === undefined) {
    return undefined;
  }
  const persona = rawOptions.persona;
  if (typeof persona !== 'string' || !CLASSROOM_PERSONA_ID_RE.test(persona)) {
    return undefined;
  }
  const rawLinked = rawOptions.linked === undefined ? [] : rawOptions.linked;
  if (
    !Array.isArray(rawLinked) ||
    rawLinked.length > CLASSROOM_CAPS.linkedDocuments
  ) {
    return undefined;
  }
  const linked: string[] = [];
  for (const item of rawLinked as unknown[]) {
    if (!isSafeRelativePath(item)) {
      return undefined;
    }
    if (!linked.includes(item)) {
      linked.push(item);
    }
  }
  let headingId: string | null = null;
  if (rawOptions.headingId !== undefined && rawOptions.headingId !== null) {
    if (
      typeof rawOptions.headingId !== 'string' ||
      rawOptions.headingId.length > CLASSROOM_CAPS.headingId ||
      /\s/.test(rawOptions.headingId)
    ) {
      return undefined;
    }
    headingId = rawOptions.headingId || null;
  }
  return {
    sourceUri,
    requestId,
    passage,
    fields,
    anchor,
    level,
    readerNote: readerNote.replace(/\s+/g, ' ').trim(),
    persona,
    audience: audience.replace(/\s+/g, ' ').trim(),
    linked,
    headingId,
  };
}

/** `readAloudClassroomCancel` -> `[sourceUri, moduleId, reason]`. */
export function parseClassroomCancelArgs(
  args: unknown,
): ClassroomCancelRequest | undefined {
  if (!Array.isArray(args) || args.length < 2 || args.length > 3) {
    return undefined;
  }
  const [sourceUri, moduleId, rawReason] = args as unknown[];
  if (!isSourceUri(sourceUri) || !isNoteId(moduleId)) {
    return undefined;
  }
  let reason = '';
  if (rawReason !== undefined && rawReason !== null) {
    if (typeof rawReason !== 'string') {
      return undefined;
    }
    reason = rawReason
      .slice(0, MAX_CANCEL_REASON_CHARS)
      .replace(/[\r\n]+/g, ' ');
  }
  return { sourceUri, moduleId, reason };
}

function parseClassroomModuleArgs(
  args: unknown,
): ClassroomModuleRequest | undefined {
  if (!Array.isArray(args) || args.length !== 2) {
    return undefined;
  }
  const [sourceUri, moduleId] = args as unknown[];
  if (!isSourceUri(sourceUri) || !isNoteId(moduleId)) {
    return undefined;
  }
  return { sourceUri, moduleId };
}

/** `readAloudClassroomContinue` -> `[sourceUri, moduleId]` (either uri). */
export function parseClassroomContinueArgs(
  args: unknown,
): ClassroomModuleRequest | undefined {
  return parseClassroomModuleArgs(args);
}

/** `readAloudClassroomOpen` -> `[sourceUri, moduleId]`. */
export function parseClassroomOpenArgs(
  args: unknown,
): ClassroomModuleRequest | undefined {
  return parseClassroomModuleArgs(args);
}

/** `readAloudClassroomOpenSource` -> `[moduleUri, moduleId]`. */
export function parseClassroomOpenSourceArgs(
  args: unknown,
): ClassroomOpenSourceRequest | undefined {
  const parsed = parseClassroomModuleArgs(args);
  return parsed
    ? { moduleUri: parsed.sourceUri, moduleId: parsed.moduleId }
    : undefined;
}

/** `readAloudClassroomOpenFolder` -> `[sourceUri]`. */
export function parseClassroomOpenFolderArgs(
  args: unknown,
): string | undefined {
  if (!Array.isArray(args) || args.length !== 1) {
    return undefined;
  }
  return isSourceUri(args[0]) ? args[0] : undefined;
}
