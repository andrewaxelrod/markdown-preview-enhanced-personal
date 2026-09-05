/*
 * The Chrome validation harness (featrues/07-eye-strain-2/spec.md §18.2):
 * the extension host's part, played in memory by a page in a plain tab so
 * the Claude in Chrome tools can drive the real player and stylesheets.
 *
 * Bundled by build.mjs into dist/host-shim.js (esbuild, IIFE). It runs
 * before the player: it defines `window.acquireVsCodeApi` with the shim as
 * the other end, seeds the player's `data-config` from the page's query
 * string and writes the two player script tags. On `readAloudSynthesize` it
 * sanitises and chunks every block exactly as `controller.ts` does (one
 * request in flight, PREFETCH_CHUNKS ahead of the last `readAloudPlaying`),
 * fetches Kokoro with the same body as `kokoro-client.ts` — the server
 * allows any origin — aligns the timestamps and posts `readAloudAudio` with
 * `blockIndex` through `window.postMessage`. With `audio=silent`, or when
 * `GET /health` does not answer within a second, it synthesises a silent WAV
 * of 0.32 s per word with evenly spaced timestamps: the visual behaviours
 * need timing, not speech. Every message and chunk is logged with the
 * `[harness]` prefix, and `window.mpeHarness` exposes `checks()`,
 * `rerender()`, `charsPerLine(el)` and the event log.
 *
 * Query parameters: theme=light|dark|auto|off, size=16..28,
 * marker=underline|box|off, dim=0|1, autohide=0|1, font=<id>,
 * palette=blue|pink|red|green|orange, speed=<rate>, vscode=light|dark
 * (the body class `auto` follows), audio=kokoro|silent,
 * kokoro=<base url>, voice=<id>.
 */

import { planReadChunks, type Chunk } from '../../src/read-aloud/chunker';
import {
  alignKokoroWords,
  type KokoroWord,
} from '../../src/read-aloud/kokoro-alignment';
import {
  DEFAULT_KOKORO_BASE_URL,
  DEFAULT_KOKORO_VOICE,
  KOKORO_REQUEST_LIMIT_CHARS,
  wordsFromWire,
} from '../../src/read-aloud/kokoro-client';
import type {
  CaptionedSpeechRequestWire,
  CaptionedSpeechResponseWire,
} from '../../src/read-aloud/kokoro-types';
import {
  clampSpeed,
  clampTextSize,
  clampVolume,
  normaliseGlobalTheme,
  normaliseHighlightTheme,
  normalisePlayerFont,
  normaliseWordMarker,
  parseCancelArgs,
  parsePlayingArgs,
  parseResetPageArgs,
  parseSetFontArgs,
  parseSetGlobalThemeArgs,
  parseSetHighlightThemeArgs,
  parseSetSpeedArgs,
  parseSetTextSizeArgs,
  parseSetVolumeArgs,
  parseSetWordMarkerArgs,
  parseSynthesizeArgs,
  type ReadAloudAudioMessage,
  type ReadAloudConfigMessage,
  type ReadAloudErrorMessage,
} from '../../src/read-aloud/messages';
import {
  mapSpanBack,
  sanitizeForSpeech,
  type SpeakableText,
} from '../../src/read-aloud/speakable';
import type { WordSpan } from '../../src/read-aloud/word-spans';

/** The host's prefetch window (controller.ts). */
const PREFETCH_CHUNKS = 2;
const SILENT_SECONDS_PER_WORD = 0.32;
const HEALTH_TIMEOUT_MS = 1000;
const LOCALE = 'en';

const params = new URLSearchParams(window.location.search);

function param(name: string): string | null {
  const value = params.get(name);
  return value === null || value === '' ? null : value;
}

function flag(name: string, fallback: boolean): boolean {
  const value = param(name);
  if (value === null) {
    return fallback;
  }
  return value !== '0' && value !== 'false' && value !== 'off';
}

const t0 = performance.now();

function stamp(): string {
  return (performance.now() - t0).toFixed(1).padStart(8) + ' ms';
}

interface HarnessEvent {
  t: number;
  kind: string;
  detail?: string;
}

const events: HarnessEvent[] = [];

function log(kind: string, detail?: string): void {
  const t = Math.round((performance.now() - t0) * 10) / 10;
  events.push(detail === undefined ? { t, kind } : { t, kind, detail });
  console.log(
    '[harness] ' +
      stamp() +
      ' ' +
      kind +
      (detail === undefined ? '' : ' ' + detail),
  );
}

// --------------------------------------------------------------- the config

/** The package defaults, which Reset page settings restores. */
const PAGE_DEFAULTS = {
  globalTheme: 'auto',
  textSize: 20,
  font: 'default',
  wordMarker: 'underline',
} as const;

const config: ReadAloudConfigMessage & { helpContextMode: string } = {
  command: 'readAloudConfig',
  enabled: true,
  clickToRead: true,
  speed: clampSpeed(Number(param('speed') ?? 1)),
  volume: clampVolume(Number(param('volume') ?? 1)),
  voiceName: param('voice') ?? DEFAULT_KOKORO_VOICE,
  modelId: 'kokoro',
  highlightTheme: normaliseHighlightTheme(param('palette') ?? 'blue'),
  font: normalisePlayerFont(param('font') ?? PAGE_DEFAULTS.font),
  globalTheme: normaliseGlobalTheme(
    param('theme') ?? PAGE_DEFAULTS.globalTheme,
  ),
  textSize: clampTextSize(Number(param('size') ?? PAGE_DEFAULTS.textSize)),
  wordMarker: normaliseWordMarker(param('marker') ?? PAGE_DEFAULTS.wordMarker),
  dimWhileReading: flag('dim', true),
  panelAutoHide: flag('autohide', true),
  helpAvailable: flag('help', false),
  helpEngine: 'claude',
  helpModel: 'sonnet',
  helpEffort: 'low',
  helpAutoPlay: true,
  helpContextMode: 'section',
};

let helpTimer = 0;

/**
 * The canned help answer (09 helper fix): the five-part shape of
 * `help-prompt.ts` §14.1, rendered the way the host's markdown engine would
 * render it, so the sheet holds real preview markup.
 */
const HELP_MARKDOWN = [
  '## What it says',
  '',
  'The passage is just one term: "SME," short for Subject Matter Expert, the person who reviews and approves the spec.',
  '',
  '## Terms',
  '',
  '- **SME**: Subject Matter Expert. Someone with deep knowledge of the business area, such as risk scoring, who checks the spec for accuracy.',
  '',
  '## In plain words',
  '',
  "An SME is the expert who reviews the spec's content, confirms it matches real business rules, and approves or flags parts of it.",
  '',
  '## An example',
  '',
  'In the passage, an SME reviewed the acceptance criteria and marked two rows testable, and later approved the whole spec on September second, twenty twenty-six.',
  '',
  '## Why it matters',
  '',
  "The SME's approval is what moves the spec's state to approved, making it trustworthy enough to build from.",
].join('\n');

const HELP_HTML = [
  '<h2>What it says</h2>',
  '<p>The passage is just one term: &quot;SME,&quot; short for Subject Matter Expert, the person who reviews and approves the spec.</p>',
  '<h2>Terms</h2>',
  '<ul>',
  '<li><strong>SME</strong>: Subject Matter Expert. Someone with deep knowledge of the business area, such as risk scoring, who checks the spec for accuracy.</li>',
  '</ul>',
  '<h2>In plain words</h2>',
  '<p>An SME is the expert who reviews the spec&#39;s content, confirms it matches real business rules, and approves or flags parts of it.</p>',
  '<h2>An example</h2>',
  '<p>In the passage, an SME reviewed the acceptance criteria and marked two rows testable, and later approved the whole spec on September second, twenty twenty-six.</p>',
  '<h2>Why it matters</h2>',
  '<p>The SME&#39;s approval is what moves the spec&#39;s state to approved, making it trustworthy enough to build from.</p>',
].join('\n');

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function postToPlayer(message: object): void {
  window.postMessage(message, '*');
}

function echoConfig(): void {
  log('config', JSON.stringify(config));
  postToPlayer({ ...config });
}

// ------------------------------------------------------------- the audio end

type AudioMode = 'kokoro' | 'silent';

const kokoroBaseUrl = (param('kokoro') ?? DEFAULT_KOKORO_BASE_URL).replace(
  /\/+$/,
  '',
);

let audioModePromise: Promise<AudioMode> | null = null;

function audioMode(): Promise<AudioMode> {
  if (audioModePromise) {
    return audioModePromise;
  }
  audioModePromise = (async () => {
    if (param('audio') === 'silent') {
      log('audio', 'silent (requested)');
      return 'silent';
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
    try {
      const response = await fetch(kokoroBaseUrl + '/health', {
        signal: controller.signal,
      });
      if (response.ok) {
        log('audio', 'kokoro at ' + kokoroBaseUrl);
        return 'kokoro';
      }
      log('audio', 'silent (health ' + response.status + ')');
    } catch (error) {
      log('audio', 'silent (health: ' + String(error) + ')');
    } finally {
      clearTimeout(timer);
    }
    return 'silent';
  })();
  return audioModePromise;
}

/** A silent 8 kHz 8-bit mono WAV of `seconds`, base64. */
function silentWav(seconds: number): string {
  const rate = 8000;
  const samples = Math.max(1, Math.round(seconds * rate));
  const bytes = new Uint8Array(44 + samples);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) {
      bytes[offset + i] = text.charCodeAt(i);
    }
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + samples, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate, true);
  view.setUint16(32, 1, true);
  view.setUint16(34, 8, true);
  ascii(36, 'data');
  view.setUint32(40, samples, true);
  bytes.fill(0x80, 44);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(
      null,
      Array.from(bytes.subarray(i, i + 0x8000)),
    );
  }
  return btoa(binary);
}

interface Synthesized {
  audioBase64: string;
  mimeType: string;
  words: KokoroWord[] | undefined;
}

async function synthesizeSilent(text: string): Promise<Synthesized> {
  const words: KokoroWord[] = [];
  const re = /\S+/g;
  let match = re.exec(text);
  let index = 0;
  while (match) {
    words.push({
      word: match[0],
      start: index * SILENT_SECONDS_PER_WORD,
      end: (index + 1) * SILENT_SECONDS_PER_WORD,
    });
    index++;
    match = re.exec(text);
  }
  return {
    audioBase64: silentWav(words.length * SILENT_SECONDS_PER_WORD + 0.05),
    mimeType: 'audio/wav',
    words,
  };
}

async function synthesizeKokoro(
  text: string,
  signal: AbortSignal,
): Promise<Synthesized> {
  const body: CaptionedSpeechRequestWire = {
    model: 'kokoro',
    input: text,
    voice: config.voiceName,
    speed: 1,
    // eslint-disable-next-line @typescript-eslint/naming-convention -- wire format
    response_format: 'mp3',
    stream: false,
    // eslint-disable-next-line @typescript-eslint/naming-convention -- wire format
    return_timestamps: true,
    // eslint-disable-next-line @typescript-eslint/naming-convention -- wire format
    normalization_options: { normalize: false },
  };
  const response = await fetch(kokoroBaseUrl + '/dev/captioned_speech', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) {
    throw new Error('Kokoro answered ' + response.status);
  }
  const json = (await response.json()) as CaptionedSpeechResponseWire;
  if (!json || typeof json.audio !== 'string' || json.audio.length === 0) {
    throw new Error('Kokoro response did not contain audio.');
  }
  return {
    audioBase64: json.audio,
    mimeType: 'audio/mpeg',
    words: wordsFromWire(json.timestamps),
  };
}

// ----------------------------------------------------------------- the job

interface JobBlock {
  index: number;
  start: number;
  speakable: SpeakableText;
}

interface Job {
  requestId: string;
  sourceUri: string;
  blocks: JobBlock[];
  chunks: Chunk[];
  posted: number;
  playing: number;
  aborted: boolean;
  wake: (() => void) | null;
}

let job: Job | null = null;

function abortJob(reason: string): void {
  if (!job) {
    return;
  }
  log('cancel', job.requestId + ' ' + reason);
  job.aborted = true;
  if (job.wake) {
    job.wake();
  }
  job = null;
}

async function waitForPrefetchWindow(
  current: Job,
  index: number,
): Promise<void> {
  while (!current.aborted && index > current.playing + PREFETCH_CHUNKS) {
    log(
      'hold',
      'chunk ' +
        (index + 1) +
        ' until chunk ' +
        (index - PREFETCH_CHUNKS + 1) +
        ' plays',
    );
    await new Promise<void>((resolve) => {
      current.wake = () => {
        current.wake = null;
        resolve();
      };
    });
  }
}

function postError(current: Job, message: string): void {
  const error: ReadAloudErrorMessage = {
    command: 'readAloudError',
    requestId: current.requestId,
    code: 'server_error',
    message,
    retryable: true,
  };
  log('error', message);
  postToPlayer(error);
}

async function runJob(current: Job): Promise<void> {
  const mode = await audioMode();
  const abort = new AbortController();
  for (const chunk of current.chunks) {
    if (current.aborted) {
      return;
    }
    await waitForPrefetchWindow(current, current.posted);
    if (current.aborted) {
      return;
    }
    const block = current.blocks[chunk.blockIndex];
    let synthesized: Synthesized;
    const started = performance.now();
    try {
      synthesized =
        mode === 'kokoro'
          ? await synthesizeKokoro(chunk.text, abort.signal)
          : await synthesizeSilent(chunk.text);
    } catch (error) {
      if (current.aborted) {
        return;
      }
      postError(current, String(error));
      if (job === current) {
        job = null;
      }
      return;
    }
    if (current.aborted) {
      return;
    }
    let spans: WordSpan[] | null = null;
    let durationHint: number | undefined;
    if (synthesized.words) {
      const aligned = alignKokoroWords(chunk.text, synthesized.words, LOCALE);
      if (aligned) {
        durationHint = aligned.audioEnd;
        spans = [];
        for (const span of aligned.spans) {
          const mapped = mapSpanBack(
            {
              ...span,
              charStart: span.charStart + chunk.charOffset,
              charEnd: span.charEnd + chunk.charOffset,
            },
            block.speakable.map,
          );
          if (mapped) {
            spans.push({
              ...mapped,
              charStart: mapped.charStart + block.start,
              charEnd: mapped.charEnd + block.start,
            });
          }
        }
      }
    }
    const message: ReadAloudAudioMessage = {
      command: 'readAloudAudio',
      requestId: current.requestId,
      chunkIndex: current.posted,
      chunkCount: current.chunks.length,
      blockIndex: block.index,
      audioBase64: synthesized.audioBase64,
      mimeType: 'audio/mpeg',
      spans,
      ...(durationHint === undefined ? {} : { durationHint }),
    };
    // The player builds its Blob from `mimeType`; the WAV stand-in says so.
    (message as { mimeType: string }).mimeType = synthesized.mimeType;
    log(
      'chunk',
      `${current.posted + 1}/${current.chunks.length} block=${block.index} chars=${chunk.text.length} words=${spans ? spans.length : 0} ${mode} ${Math.round(performance.now() - started)} ms`,
    );
    postToPlayer(message);
    current.posted++;
    if (current.posted === current.chunks.length && job === current) {
      job = null;
    }
  }
}

function handleSynthesize(args: unknown): void {
  const request = parseSynthesizeArgs(args);
  if (!request) {
    log('dropped invalid readAloudSynthesize message');
    return;
  }
  abortJob('superseded');
  const ranges = request.options.blocks ?? [
    { key: '', start: 0, end: request.text.length },
  ];
  const blocks: JobBlock[] = ranges.map((range, index) => ({
    index,
    start: range.start,
    speakable: sanitizeForSpeech(request.text.slice(range.start, range.end)),
  }));
  const plan = planReadChunks(
    blocks.map((block) => block.speakable.text),
    KOKORO_REQUEST_LIMIT_CHARS,
    LOCALE,
  );
  const current: Job = {
    requestId: request.requestId,
    sourceUri: request.sourceUri,
    blocks,
    chunks: plan.chunks,
    posted: 0,
    playing: -1,
    aborted: false,
    wake: null,
  };
  job = current;
  log(
    'plan',
    `${request.requestId} kind=${request.options.kind} blocks=${blocks.length} chunks=${plan.chunks.length} chars=${request.text.length}`,
  );
  if (plan.chunks.length === 0) {
    postToPlayer({
      command: 'readAloudError',
      requestId: request.requestId,
      code: 'empty_text',
      message: 'Nothing to read.',
      retryable: false,
    });
    job = null;
    return;
  }
  void runJob(current);
}

function handleMessage(message: { command?: unknown; args?: unknown }): void {
  const command = typeof message.command === 'string' ? message.command : '';
  const args = message.args;
  switch (command) {
    case 'readAloudSynthesize':
      handleSynthesize(args);
      return;
    case 'readAloudCancel': {
      const cancel = parseCancelArgs(args);
      if (!cancel) {
        log('dropped invalid readAloudCancel message');
        return;
      }
      if (job && job.requestId === cancel.requestId) {
        abortJob(cancel.reason ?? 'end');
      }
      return;
    }
    case 'readAloudPlaying': {
      const playing = parsePlayingArgs(args);
      if (!playing) {
        log('dropped invalid readAloudPlaying message');
        return;
      }
      log('playing', 'chunk ' + (playing.chunkIndex + 1));
      if (job && job.requestId === playing.requestId) {
        job.playing = Math.max(job.playing, playing.chunkIndex);
        if (job.wake) {
          job.wake();
        }
      }
      return;
    }
    case 'readAloudSetSpeed': {
      const rate = parseSetSpeedArgs(args);
      if (rate === undefined) {
        log('dropped invalid readAloudSetSpeed message');
        return;
      }
      config.speed = rate;
      log('set', 'speed ' + rate);
      echoConfig();
      return;
    }
    case 'readAloudSetVolume': {
      const level = parseSetVolumeArgs(args);
      if (level === undefined) {
        log('dropped invalid readAloudSetVolume message');
        return;
      }
      config.volume = level;
      log('set', 'volume ' + level);
      echoConfig();
      return;
    }
    case 'readAloudSetHighlightTheme': {
      const theme = parseSetHighlightThemeArgs(args);
      if (theme === undefined) {
        log('dropped invalid readAloudSetHighlightTheme message');
        return;
      }
      config.highlightTheme = theme;
      log('set', 'highlightTheme ' + theme);
      echoConfig();
      return;
    }
    case 'readAloudSetFont': {
      const font = parseSetFontArgs(args);
      if (font === undefined) {
        log('dropped invalid readAloudSetFont message');
        return;
      }
      config.font = font;
      log('set', 'font ' + font);
      echoConfig();
      return;
    }
    case 'readAloudSetGlobalTheme': {
      const theme = parseSetGlobalThemeArgs(args);
      if (theme === undefined) {
        log('dropped invalid readAloudSetGlobalTheme message');
        return;
      }
      config.globalTheme = theme;
      log('set', 'globalTheme ' + theme);
      echoConfig();
      return;
    }
    case 'readAloudSetTextSize': {
      const size = parseSetTextSizeArgs(args);
      if (size === undefined) {
        log('dropped invalid readAloudSetTextSize message');
        return;
      }
      config.textSize = size;
      log('set', 'textSize ' + size);
      echoConfig();
      return;
    }
    case 'readAloudSetWordMarker': {
      const marker = parseSetWordMarkerArgs(args);
      if (marker === undefined) {
        log('dropped invalid readAloudSetWordMarker message');
        return;
      }
      config.wordMarker = marker;
      log('set', 'wordMarker ' + marker);
      echoConfig();
      return;
    }
    case 'readAloudResetPage':
      if (!parseResetPageArgs(args)) {
        log('dropped invalid readAloudResetPage message');
        return;
      }
      config.globalTheme = PAGE_DEFAULTS.globalTheme;
      config.textSize = PAGE_DEFAULTS.textSize;
      config.font = PAGE_DEFAULTS.font;
      config.wordMarker = PAGE_DEFAULTS.wordMarker;
      log('reset', 'page settings');
      echoConfig();
      return;
    case 'readAloudOpenSetup':
    case 'readAloudHelpChooseModel':
      log(command, 'ignored');
      return;
    case 'readAloudHelp': {
      // A canned answer in the shape §14.1 asks for, so the sheet's
      // typography can be measured without a CLI (09 helper fix).
      const requestId = Array.isArray(args) ? args[1] : undefined;
      log(command, 'canned answer for ' + String(requestId));
      helpTimer = window.setTimeout(
        () => {
          postToPlayer({
            command: 'readAloudHelpResult',
            requestId,
            markdown: HELP_MARKDOWN,
            html: HELP_HTML,
          });
        },
        Number(param('helpdelay') ?? 400),
      );
      return;
    }
    case 'readAloudHelpCancel':
      window.clearTimeout(helpTimer);
      log(command, 'canned request cancelled');
      return;
    default:
      log('unknown message', command);
  }
}

// ----------------------------------------------------- the webview API end

(window as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi =
  function acquireVsCodeApi() {
    return {
      postMessage(message: { command?: unknown; args?: unknown }) {
        try {
          handleMessage(message);
        } catch (error) {
          console.error('[harness] handler threw', error);
        }
      },
      getState() {
        return undefined;
      },
      setState() {
        /* nothing to keep */
      },
    };
  };

// The media elements: every play() and `ended` is logged, so a block gap
// (07 §11) can be read off the console (check H8).
const RealAudio = window.Audio;
let audioCount = 0;
(window as unknown as { Audio: unknown }).Audio = function HarnessAudio(
  this: unknown,
  src?: string,
) {
  const el = src === undefined ? new RealAudio() : new RealAudio(src);
  const id = ++audioCount;
  el.addEventListener('play', () => {
    log('play', 'audio#' + id + ' ' + el.src.slice(0, 24));
  });
  el.addEventListener('ended', () => {
    log('ended', 'audio#' + id);
  });
  el.addEventListener('pause', () => {
    if (!el.ended) {
      log('pause', 'audio#' + id);
    }
  });
  return el;
} as unknown as typeof Audio;

// scrollIntoView is counted: the follow loop must never call it (H3).
let scrollIntoViewCalls = 0;
const realScrollIntoView = Element.prototype.scrollIntoView;
Element.prototype.scrollIntoView = function scrollIntoView(
  this: Element,
  arg?: boolean | ScrollIntoViewOptions,
) {
  scrollIntoViewCalls++;
  log('scrollIntoView', String(this.className));
  return realScrollIntoView.call(this, arg as ScrollIntoViewOptions);
};

// The body class `auto` follows (05 §4.2).
const vscodeKind = param('vscode') === 'dark' ? 'vscode-dark' : 'vscode-light';

// The player, with its data-config, written in the head order the extension
// uses (preview-provider.ts): core first, then the player.
// A `?t=` query on each, so an edited player is never served from cache.
const bust = '?t=' + Date.now();
document.write(
  '<script src="../../media/read-aloud-core.js' +
    bust +
    '"></script>' +
    '<script src="../../media/read-aloud.js' +
    bust +
    '" data-config="' +
    escapeAttribute(JSON.stringify(config)) +
    '"></script>',
);

// ------------------------------------------------------------ the fixture

let fixtureHtml = '';

function root(): HTMLElement | null {
  return document.querySelector('.markdown-preview[data-for="preview"]');
}

async function loadFixture(): Promise<void> {
  const response = await fetch('fixture.html');
  fixtureHtml = await response.text();
  const target = root();
  if (target) {
    target.innerHTML = fixtureHtml;
    log('fixture', target.children.length + ' top-level elements');
  }
}

/** Replace the root's children with a fresh copy, as an `updateHtml` would. */
function rerender(): number {
  const target = root();
  if (!target) {
    return 0;
  }
  target.innerHTML = fixtureHtml;
  log('rerender', target.children.length + ' elements');
  return target.children.length;
}

// -------------------------------------------------------------- the checks

/** Characters per rendered line of `el`, from a Range per character. */
function charsPerLine(el: Element): number[] {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const lines = new Map<number, number>();
  let node = walker.nextNode();
  while (node) {
    const text = node.textContent || '';
    for (let i = 0; i < text.length; i++) {
      if (/\s/.test(text[i])) {
        // Spaces count when they sit between characters of the same line;
        // the line's own trailing space is dropped by the browser.
      }
      const range = document.createRange();
      range.setStart(node, i);
      range.setEnd(node, i + 1);
      const rect = range.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) {
        continue;
      }
      const key = Math.round(rect.top);
      lines.set(key, (lines.get(key) || 0) + 1);
    }
    node = walker.nextNode();
  }
  return Array.from(lines.entries())
    .sort((a, b) => a[0] - b[0])
    .map((entry) => entry[1]);
}

function hexToRgb(color: string): [number, number, number] | null {
  const m = /rgba?\(\s*([\d.]+)\s*[, ]\s*([\d.]+)\s*[, ]\s*([\d.]+)/.exec(
    color,
  );
  if (m) {
    return [Number(m[1]), Number(m[2]), Number(m[3])];
  }
  const h = /^#([0-9a-f]{6})$/i.exec(color.trim());
  if (h) {
    const n = parseInt(h[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  return null;
}

function luminance(color: string): number | null {
  const rgb = hexToRgb(color);
  if (!rgb) {
    return null;
  }
  const [r, g, b] = rgb.map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2.x contrast of two computed colours, or null. */
function contrast(a: string, b: string): number | null {
  const la = luminance(a);
  const lb = luminance(b);
  if (la === null || lb === null) {
    return null;
  }
  return (
    Math.round(((Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)) * 100) /
    100
  );
}

function median(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function checks(): Record<string, unknown> {
  const html = document.documentElement;
  const body = document.body;
  const target = root();
  const bodyStyle = getComputedStyle(body);
  const h1 = target ? target.querySelector('h1') : null;
  const paragraphs = target
    ? Array.from(target.querySelectorAll(':scope > p')).slice(0, 10)
    : [];
  const fullLines: number[] = [];
  const perParagraph: number[][] = [];
  for (const p of paragraphs) {
    const lines = charsPerLine(p);
    perParagraph.push(lines);
    // Full lines: every line but the last of a paragraph with more than one.
    if (lines.length > 1) {
      fullLines.push(...lines.slice(0, -1));
    }
  }
  const word = document.querySelector('.mpe-ra-word');
  const wordStyle = word ? getComputedStyle(word) : null;
  const rootStyle = target ? getComputedStyle(target) : null;
  const pill = document.querySelector('.mpe-ra-pill');
  const pillStyle = pill ? getComputedStyle(pill) : null;
  const bar = document.querySelector('.mpe-ra-bar');
  const strip = document.querySelector('.mpe-ra-strip');
  const chip = document.querySelector('.mpe-ra-bar-chip') as HTMLElement | null;
  const tiers = target
    ? Array.from(target.children).map((el) => ({
        tag: el.tagName.toLowerCase(),
        id: el.id,
        tier: el.classList.contains('mpe-ra-tier-near')
          ? 'near'
          : el.classList.contains('mpe-ra-tier-far')
            ? 'far'
            : el.classList.contains('mpe-ra-reading')
              ? 'active'
              : '',
        color: getComputedStyle(el).color,
      }))
    : [];
  const sizeRange = document.querySelector(
    '.mpe-ra-sheet-size',
  ) as HTMLInputElement | null;
  const link = target ? target.querySelector('a[href]') : null;
  return {
    page: html.getAttribute('data-mpe-ra-page'),
    marker: target ? target.getAttribute('data-mpe-ra-marker') : null,
    textSizeProp: html.style.getPropertyValue('--mpe-ra-page-text-size'),
    lineHeightProp: html.style.getPropertyValue('--mpe-ra-page-line-height'),
    measureProp: html.style.getPropertyValue('--mpe-ra-page-measure'),
    bodyFontSize: bodyStyle.fontSize,
    bodyLineHeight: bodyStyle.lineHeight,
    bodyFontFamily: bodyStyle.fontFamily,
    h1FontSize: h1 ? getComputedStyle(h1).fontSize : null,
    columnContentWidth: rootStyle ? rootStyle.width : null,
    columnBoxSizing: rootStyle ? rootStyle.boxSizing : null,
    charsPerLine: {
      median: median(fullLines),
      max: fullLines.length ? Math.max(...fullLines) : 0,
      min: fullLines.length ? Math.min(...fullLines) : 0,
      fullLines: fullLines.length,
      perParagraph,
    },
    sheet: {
      sizeLabel: sizeRange
        ? (sizeRange.parentElement as HTMLElement).firstChild?.textContent
        : null,
      sizeDisabled: sizeRange ? sizeRange.disabled : null,
    },
    word: wordStyle
      ? {
          text: word ? word.textContent : '',
          backgroundColor: wordStyle.backgroundColor,
          boxShadow: wordStyle.boxShadow,
          color: wordStyle.color,
          padding: wordStyle.padding,
          margin: wordStyle.margin,
          pill: pillStyle ? pillStyle.backgroundColor : null,
          textOnBox: contrast(wordStyle.color, wordStyle.backgroundColor),
          strokeOnPill:
            pillStyle && word
              ? contrast(
                  getComputedStyle(word)
                    .getPropertyValue('--mpe-ra-word-line')
                    .trim() || 'rgb(0,0,0)',
                  pillStyle.backgroundColor,
                )
              : null,
          stroke: word
            ? getComputedStyle(word)
                .getPropertyValue('--mpe-ra-word-line')
                .trim()
            : null,
        }
      : null,
    tiers,
    link: link
      ? {
          color: getComputedStyle(link).color,
          textDecorationLine: getComputedStyle(link).textDecorationLine,
        }
      : null,
    panel: {
      idle: bar ? bar.classList.contains('mpe-ra-bar-idle') : null,
      opacity: bar ? getComputedStyle(bar).opacity : null,
      fontSize: bar ? getComputedStyle(bar).fontSize : null,
      stripHidden: strip ? (strip as HTMLElement).hidden : null,
      stripWidth: strip
        ? (strip.firstElementChild as HTMLElement).style.width
        : null,
      chipHidden: chip ? chip.hidden : null,
    },
    scroll: {
      scrollY: window.scrollY,
      innerHeight: window.innerHeight,
      wordTop: word ? word.getBoundingClientRect().top : null,
      wordTopFraction: word
        ? Math.round(
            (word.getBoundingClientRect().top / window.innerHeight) * 1000,
          ) / 1000
        : null,
      scrollIntoViewCalls,
    },
    audio: audioModePromise ? 'probed' : 'not probed',
    config: { ...config },
  };
}

(window as unknown as { mpeHarness: unknown }).mpeHarness = {
  checks,
  rerender,
  charsPerLine,
  events,
  config,
  get scrollIntoViewCalls() {
    return scrollIntoViewCalls;
  },
  get fixture() {
    return fixtureHtml;
  },
  audioMode,
};

document.addEventListener('DOMContentLoaded', () => {
  document.body.classList.add(vscodeKind);
  void loadFixture();
  void audioMode();
});

log('shim', 'ready ' + JSON.stringify(Object.fromEntries(params.entries())));
