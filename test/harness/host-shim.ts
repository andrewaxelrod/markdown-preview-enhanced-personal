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
import planAnswer from '../classroom/fixtures/plan-answer.md';
import { parsePlan } from '../../src/classroom/plan-prompt';
import {
  clampSpeed,
  clampTextSize,
  clampVolume,
  normaliseGlobalTheme,
  normaliseHighlightTheme,
  normaliseNotesDecoration,
  normalisePlayerFont,
  normaliseWordMarker,
  parseCancelArgs,
  parseClassroomBuildArgs,
  parseClassroomCancelArgs,
  parseClassroomContinueArgs,
  parseClassroomOpenArgs,
  parseClassroomOpenFolderArgs,
  parseClassroomOpenSourceArgs,
  parseClassroomPrepareArgs,
  parseNoteAnchorsArgs,
  parseNoteCopyArgs,
  parseNoteCreateArgs,
  parseNoteDeleteArgs,
  parseNoteOpenArgs,
  parseNoteReattachArgs,
  parseNoteRegenerateArgs,
  parseNotesShowAllArgs,
  parseNoteUndoDeleteArgs,
  parseNoteUpdateArgs,
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
  type ClassroomChapterState,
  type ClassroomProgress,
  type NoteSummary,
  type ReadAloudAudioMessage,
  type ReadAloudConfigMessage,
  type ReadAloudErrorMessage,
} from '../../src/read-aloud/messages';
import {
  applyGenerated,
  generatedMarkdown,
  generatedSectionsInOrder,
  summaryLineOf,
  titleFromPassage,
  type NoteSectionName,
  type ParsedNote,
} from '../../src/notes/note-format';
import { parseNoteAnswer } from '../../src/notes/note-prompt';
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
  // Notes (12 §18): `notes=1` seeds three canned notes and answers every
  // note message from an in-memory store.
  notesAvailable: flag('notes', false),
  notesDecoration: normaliseNotesDecoration(
    param('decoration') ?? 'marker-and-mark',
  ),
  // Classroom (13 §18): `classroom=1` answers Prepare and Build with canned
  // messages; `module=1` makes the fixture itself a module preview.
  classroomAvailable: flag('classroom', false),
  classroomModule: null,
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
      if (handleNoteMessage(command, args)) {
        return;
      }
      if (handleClassroomMessage(command, args)) {
        return;
      }
      log('unknown message', command);
  }
}

// -------------------------------------------------------- the classroom end

/**
 * 13 §18 — the host's part of a classroom build, in memory. Prepare is
 * answered at once with Max, two linked documents, one existing module and
 * the fixture's word count; Build with a sequence of `Progress` messages
 * built from the experiment's plan, one every `classroomdelay` ms (default
 * 800): planning, then each chapter writing and done, then done.
 * `classroomfail=<n>` fails chapter n with a canned reason; Cancel stops the
 * sequence and posts stopped; Continue resumes from the first chapter not
 * done. `module=1` puts a canned `classroomModule` into the config, with
 * `modulestatus=writing|done|stopped|failed`.
 */
const CLASSROOM_DELAY_MS = Number(param('classroomdelay') ?? 800);
const CLASSROOM_FAIL_AT = Number(param('classroomfail') ?? 0);
const CLASSROOM_MODULE_ID = '20260905T173010Z-4c2e';
const CLASSROOM_MODULE_URI =
  'file:///harness/classroom/modules/harness/fixture.md/20260905T173010Z-4c2e-the-measure.md';
const CLASSROOM_PLAN = (() => {
  const parsed = parsePlan(planAnswer, 2, [5, 6], 'the measure');
  return parsed.ok ? parsed.plan : null;
})();

interface ClassroomBuildState {
  chapters: ClassroomChapterState[];
  status: ClassroomProgress['status'];
  documentUri: string;
  startedAt: number;
  timer: number;
  error: string | null;
  words: number;
}

let classroomBuild: ClassroomBuildState | null = null;

function classroomProgressOf(
  state: ClassroomBuildState,
  chapter: number,
): ClassroomProgress {
  const writing = state.chapters.find((c) => c.status === 'writing');
  return {
    moduleId: CLASSROOM_MODULE_ID,
    documentUri: state.documentUri,
    moduleUri: CLASSROOM_MODULE_URI,
    status: state.status,
    title: CLASSROOM_PLAN ? CLASSROOM_PLAN.title : 'Classroom: the measure',
    chapter: writing ? writing.n : chapter,
    of: state.chapters.length,
    chapterTitle: writing ? writing.title : '',
    chapters: state.chapters.map((c) => ({ ...c, flagged: c.flagged.slice() })),
    elapsedMs: performance.now() - state.startedAt,
    words: state.words,
    queuePosition: 0,
    error: state.error,
    hasChapter: state.chapters.some((c) => c.status === 'done'),
  };
}

function postClassroomProgress(state: ClassroomBuildState, chapter = 0): void {
  const progress = classroomProgressOf(state, chapter);
  log(
    'classroom',
    progress.status + ' ' + progress.chapter + '/' + progress.of,
  );
  postToPlayer({ command: 'readAloudClassroomProgress', ...progress });
}

/** One step of the canned sequence, `CLASSROOM_DELAY_MS` after the last. */
function classroomStep(state: ClassroomBuildState): void {
  if (classroomBuild !== state) {
    return;
  }
  const writing = state.chapters.findIndex((c) => c.status === 'writing');
  if (writing >= 0) {
    // The chapter being written is done, or fails.
    if (CLASSROOM_FAIL_AT === writing + 1) {
      state.chapters[writing].status = 'failed';
      state.status = 'failed';
      state.error =
        'claude exited with code 1: canned failure for chapter ' +
        (writing + 1);
      postClassroomProgress(state);
      classroomBuild = null;
      return;
    }
    state.chapters[writing].status = 'done';
    state.chapters[writing].flagged = writing === 1 ? ['length-target'] : [];
    state.words += writing === 0 ? 292 : 500;
  }
  const next = state.chapters.findIndex((c) => c.status !== 'done');
  if (next < 0) {
    state.status = 'done';
    postClassroomProgress(state);
    classroomBuild = null;
    return;
  }
  state.chapters[next].status = 'writing';
  state.status = 'writing';
  postClassroomProgress(state, next + 1);
  state.timer = window.setTimeout(
    () => classroomStep(state),
    CLASSROOM_DELAY_MS,
  );
}

function startClassroomBuild(
  documentUri: string,
  resume: ClassroomBuildState | null,
): void {
  const chapters: ClassroomChapterState[] = resume
    ? resume.chapters.map((c) => ({
        ...c,
        status: c.status === 'done' ? 'done' : 'queued',
      }))
    : (CLASSROOM_PLAN ? CLASSROOM_PLAN.chapters : []).map((c) => ({
        n: c.n,
        title: c.title,
        status: 'queued',
        flagged: [],
      }));
  const state: ClassroomBuildState = {
    chapters,
    status: resume ? 'writing' : 'planning',
    documentUri,
    startedAt: performance.now(),
    timer: 0,
    error: null,
    words: resume ? resume.words : 0,
  };
  classroomBuild = state;
  if (!resume) {
    // Planning shows before the plan's rows exist.
    const planning: ClassroomBuildState = { ...state, chapters: [] };
    postClassroomProgress(planning);
  }
  state.timer = window.setTimeout(
    () => classroomStep(state),
    CLASSROOM_DELAY_MS,
  );
}

let lastClassroomBuild: ClassroomBuildState | null = null;

function handleClassroomMessage(command: string, args: unknown): boolean {
  switch (command) {
    case 'readAloudClassroomPrepare': {
      const request = parseClassroomPrepareArgs(args);
      if (!request) {
        log('dropped invalid readAloudClassroomPrepare message');
        return true;
      }
      const words = (root()?.textContent ?? '')
        .split(/\s+/)
        .filter(Boolean).length;
      log('classroom', 'prepared ' + words + ' words');
      postToPlayer({
        command: 'readAloudClassroomPrepared',
        requestId: request.requestId,
        persona: {
          id: 'max',
          name: 'Max',
          tagline:
            'A patient practitioner who explains the machinery one on one',
        },
        personas: [
          {
            id: 'max',
            name: 'Max',
            tagline:
              'A patient practitioner who explains the machinery one on one',
          },
          { id: 'ada', name: 'Ada', tagline: 'Diagrams first, then words' },
        ],
        audience:
          'a professionally motivated reader who has used at least one AI agent as a user, is comfortable with everyday computing, and is not a programmer',
        documentWords: words,
        linked: [
          {
            path: 'featrues/04-help-module.md',
            title: '04 — Help: explain the selection',
            words: 6100,
          },
          {
            path: 'featrues/12-notes/spec.md',
            title: '12 — Notes',
            words: 9000,
          },
        ],
        modules: [
          {
            id: '20260905T170000Z-aaaa',
            title: 'An Earlier Module',
            created: '2026-09-05T17:00:00Z',
            status: 'done',
            chapters: 6,
            done: 6,
            minutes: 20,
          },
        ],
        engine: { engine: 'claude', model: 'sonnet', effort: 'medium' },
        building: classroomBuild
          ? classroomProgressOf(classroomBuild, 0)
          : null,
      });
      return true;
    }
    case 'readAloudClassroomBuild': {
      const request = parseClassroomBuildArgs(args);
      if (!request) {
        log('dropped invalid readAloudClassroomBuild message');
        return true;
      }
      log(
        'classroom',
        'build level ' +
          request.level +
          ' ' +
          request.persona +
          ' linked ' +
          request.linked.join(',') +
          ' note ' +
          JSON.stringify(request.readerNote),
      );
      startClassroomBuild(request.sourceUri, null);
      return true;
    }
    case 'readAloudClassroomCancel': {
      const request = parseClassroomCancelArgs(args);
      if (!request) {
        log('dropped invalid readAloudClassroomCancel message');
        return true;
      }
      if (classroomBuild) {
        window.clearTimeout(classroomBuild.timer);
        const state = classroomBuild;
        classroomBuild = null;
        for (const chapter of state.chapters) {
          if (chapter.status === 'writing') {
            chapter.status = 'queued';
          }
        }
        state.status = 'stopped';
        lastClassroomBuild = state;
        log('classroom', 'cancelled (' + request.reason + ')');
        postClassroomProgress(state);
      }
      return true;
    }
    case 'readAloudClassroomContinue': {
      const request = parseClassroomContinueArgs(args);
      if (!request) {
        log('dropped invalid readAloudClassroomContinue message');
        return true;
      }
      const resume = lastClassroomBuild;
      if (resume && !classroomBuild) {
        for (const chapter of resume.chapters) {
          if (chapter.status === 'failed') {
            chapter.status = 'queued';
          }
        }
        log(
          'classroom',
          'continue from ' +
            (resume.chapters.filter((c) => c.status === 'done').length + 1),
        );
        startClassroomBuild(resume.documentUri, resume);
      }
      return true;
    }
    case 'readAloudClassroomOpen':
      log(
        'classroom',
        'open ' + JSON.stringify(parseClassroomOpenArgs(args) ?? 'invalid'),
      );
      return true;
    case 'readAloudClassroomOpenSource':
      log(
        'classroom',
        'open source ' +
          JSON.stringify(parseClassroomOpenSourceArgs(args) ?? 'invalid'),
      );
      return true;
    case 'readAloudClassroomOpenFolder':
      log(
        'classroom',
        'open folder ' +
          JSON.stringify(parseClassroomOpenFolderArgs(args) ?? 'invalid'),
      );
      return true;
    default:
      return false;
  }
}

/** `module=1` — the fixture is a module preview; the message line follows. */
function seedModule(): void {
  if (!flag('module', false) || !CLASSROOM_PLAN) {
    return;
  }
  const status = (param('modulestatus') ??
    'writing') as ClassroomProgress['status'];
  const chapters: ClassroomChapterState[] = CLASSROOM_PLAN.chapters.map(
    (c, i) => ({
      n: c.n,
      title: c.title,
      status:
        status === 'done'
          ? 'done'
          : i < 2
            ? 'done'
            : i === 2
              ? status === 'writing'
                ? 'writing'
                : status === 'failed'
                  ? 'failed'
                  : 'queued'
              : 'queued',
      flagged: i === 1 ? ['length-target'] : [],
    }),
  );
  config.classroomModule = {
    id: CLASSROOM_MODULE_ID,
    title: CLASSROOM_PLAN.title,
    status,
    chapters,
    documentTitle: 'Module 1: The Governed Harness',
    documentPath: 'test-file.md',
    documentHeading: 'The Governed Path: From Issue to Merge',
  };
  echoConfig();
  const state: ClassroomBuildState = {
    chapters,
    status,
    documentUri: 'file:///harness/source.md',
    startedAt: performance.now(),
    timer: 0,
    error:
      status === 'failed' ? 'claude exited with code 1: canned failure' : null,
    words: status === 'done' ? 3000 : 1043,
  };
  postClassroomProgress(state, 3);
}

// ------------------------------------------------------------ the notes end

/**
 * 12 §18 — an in-memory notes store. `readAloudNoteCreate` writes a pending
 * note at once and fills the generated sections in after `notesdelay` ms
 * (default 1,500) from a canned skeleton in the shape of §21.1; every other
 * note message is applied to the store and echoed as `readAloudNotes`. Three
 * notes are seeded against the fixture: one mid-paragraph, one on a list
 * item, one whose passage is not in the fixture (an orphan). `count=0` seeds
 * none.
 */
const NOTES_DELAY_MS = Number(param('notesdelay') ?? 1500);
const NOTES_SOURCE_URI = 'file:///harness/fixture.md';

const NOTE_ANSWER = [
  '# The measure: how many characters fit a line',
  '',
  '## Summary',
  'The passage fixes the measure at sixty-six characters, the middle of the forty-five to seventy-five band typographers recommend for running text.',
  '',
  '## Why it matters',
  'The whole page is set from this one number, so the eye can sweep a line and find the next.',
  '',
  '## Terms',
  '- **Measure**: the number of characters on a line, spaces included.',
  "- **Return sweep**: the eye's jump from the end of one line to the start of the next.",
  '',
  'Tags: measure, typography, reading',
].join('\n');

const notesStore = new Map<string, ParsedNote>();
const notesDeleting = new Map<string, number>();
let noteSequence = 0;

function noteNow(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function newNoteId(): string {
  noteSequence++;
  const now = new Date();
  const pad = (n: number, w: number) => String(n).padStart(w, '0');
  const stamp =
    `${pad(now.getUTCFullYear(), 4)}${pad(now.getUTCMonth() + 1, 2)}${pad(now.getUTCDate(), 2)}` +
    `T${pad(now.getUTCHours(), 2)}${pad(now.getUTCMinutes(), 2)}${pad(now.getUTCSeconds(), 2)}Z`;
  return `${stamp}-${(0x1000 + noteSequence).toString(16).slice(-4)}`;
}

/** The rendered sections: a tiny markdown-to-HTML for the canned shapes. */
function renderSections(markdown: string): string {
  const out: string[] = [];
  let list: string[] = [];
  const flushList = () => {
    if (list.length) {
      out.push('<ul>' + list.join('') + '</ul>');
      list = [];
    }
  };
  for (const raw of markdown.split('\n')) {
    const line = raw.trim();
    if (!line) {
      continue;
    }
    const inline = line
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/`([^`]+)`/g, '<code>$1</code>');
    if (/^### /.test(line)) {
      flushList();
      out.push('<h3>' + inline.slice(4) + '</h3>');
    } else if (/^## /.test(line)) {
      flushList();
      out.push('<h2>' + inline.slice(3) + '</h2>');
    } else if (/^[-*] /.test(line)) {
      list.push('<li>' + inline.slice(2) + '</li>');
    } else {
      flushList();
      out.push('<p>' + inline + '</p>');
    }
  }
  flushList();
  return out.join('');
}

function summaryOf(note: ParsedNote): NoteSummary {
  const sectionsMarkdown = generatedMarkdown(note);
  return {
    id: note.id,
    title: note.title,
    titleEdited: note.titleEdited,
    shape: note.shape,
    created: note.created,
    updated: note.updated,
    headings: note.document.headings.slice(),
    passage: note.passage,
    anchor: {
      block: note.anchor.block,
      line: note.anchor.line,
      exact: note.anchor.exact,
      prefix: note.anchor.prefix,
      suffix: note.anchor.suffix,
      offset: note.anchor.offset,
      blocks: note.anchor.blocks,
      lastSeen: note.anchor.lastSeen,
      missingSince: note.anchor.missingSince,
      current: note.anchor.current ? { ...note.anchor.current } : undefined,
    },
    generated: { ...note.generated },
    tags: note.tags.slice(),
    myNote: note.myNote,
    html: sectionsMarkdown ? renderSections(sectionsMarkdown) : '',
    sectionsMarkdown,
    sectionNames: generatedSectionsInOrder(note).map((s) => s.heading),
    context: { ...note.context },
    summaryLine: summaryLineOf(note),
  };
}

function postNotes(): void {
  const deleting = Array.from(notesDeleting.keys());
  const notes = Array.from(notesStore.values())
    .filter((note) => !notesDeleting.has(note.id))
    .sort((a, b) =>
      a.created < b.created ? -1 : a.created > b.created ? 1 : 0,
    )
    .map(summaryOf);
  postToPlayer({
    command: 'readAloudNotes',
    sourceUri: NOTES_SOURCE_URI,
    notes,
    deleting,
    deleteMode: 'trash',
    generate: flag('generate', true),
  });
  log(
    'notes',
    'posted ' +
      notes.length +
      (deleting.length ? ' (+' + deleting.length + ' deleting)' : ''),
  );
}

function makeNote(input: {
  passage: string;
  headings: string[];
  anchor: ParsedNote['anchor'];
  enclosing: string;
  status: 'pending' | 'done';
  source?: 'engine' | 'help';
  explanation?: string;
}): ParsedNote {
  const now = noteNow();
  const sections = new Map<NoteSectionName, string>();
  if (input.explanation) {
    sections.set('Explanation', input.explanation);
  }
  return {
    id: newNoteId(),
    created: now,
    updated: now,
    shape: input.passage.trim().split(/\s+/).length <= 5 ? 'term' : 'passage',
    titleEdited: false,
    document: {
      workspace: 'harness',
      path: 'fixture.md',
      absolute: '/harness/fixture.md',
      title: 'Reading on a screen, without the strain',
      headings: input.headings,
      git: { remote: '', commit: '' },
    },
    anchor: { ...input.anchor, lastSeen: now },
    generated:
      input.status === 'done'
        ? {
            status: 'done',
            source: input.source ?? 'engine',
            engine: 'claude',
            model: 'sonnet',
            effort: 'low',
            at: now,
          }
        : { status: 'pending', source: 'engine' },
    tags: [],
    unknown: {},
    title: titleFromPassage(input.passage),
    passage: input.passage,
    sections,
    extras: [],
    myNote: '',
    context: { enclosing: input.enclosing, before: '', after: '' },
  };
}

function generateNote(id: string, delay: number): void {
  window.setTimeout(() => {
    const note = notesStore.get(id);
    if (!note || note.generated.status !== 'pending') {
      return;
    }
    const parts = parseNoteAnswer(NOTE_ANSWER, note.passage);
    const next = applyGenerated(note, parts);
    const at = noteNow();
    next.generated = {
      status: 'done',
      source: 'engine',
      engine: 'claude',
      model: 'sonnet',
      effort: 'low',
      prompt: 1,
      at,
    };
    next.updated = at;
    notesStore.set(id, next);
    log('notes', 'generated ' + id);
    postNotes();
  }, delay);
}

/** Seed the canned notes once the fixture is in the page (its keys depend on it). */
function seedNotes(): void {
  if (!config.notesAvailable || param('count') === '0') {
    return;
  }
  const core = (window as unknown as { MpeReadAloudCore: any })
    .MpeReadAloudCore;
  const target = root();
  if (!core || !target) {
    return;
  }
  const children = Array.from(target.children);
  const blockKey = (el: Element) =>
    core.blockKey(el, core.extractText(el).text) as string;
  const paragraph = children.find(
    (el) =>
      el.tagName === 'P' &&
      (el.textContent ?? '').includes('sixty-six is the figure'),
  );
  const list = children.find((el) => el.tagName === 'UL');
  if (paragraph) {
    const text = core.extractText(paragraph).text as string;
    const passage = 'sixty-six is the figure that appears most often';
    const offset = text.indexOf(passage);
    const note = makeNote({
      passage,
      headings: ['Reading on a screen, without the strain', 'The measure'],
      anchor: {
        block: blockKey(paragraph),
        line: Number(paragraph.getAttribute('data-source-line') ?? 0) || null,
        exact: passage,
        prefix: text.slice(Math.max(0, offset - 64), offset),
        suffix: text.slice(
          offset + passage.length,
          offset + passage.length + 64,
        ),
        offset,
        blocks: 1,
      },
      enclosing: text.replace(passage, '⟦' + passage + '⟧'),
      status: 'done',
    });
    const parts = parseNoteAnswer(NOTE_ANSWER, passage);
    notesStore.set(note.id, applyGenerated(note, parts));
  }
  if (list) {
    const item = list.querySelector('li');
    const text = core.extractText(list).text as string;
    const passage = (item?.textContent ?? '')
      .trim()
      .split('\n')[0]
      .slice(0, 40)
      .trim();
    const offset = text.indexOf(passage);
    if (passage && offset >= 0) {
      const note = makeNote({
        passage,
        headings: ['Reading on a screen, without the strain', 'The measure'],
        anchor: {
          block: blockKey(list),
          line: Number(item?.getAttribute('data-source-line') ?? 0) || null,
          exact: passage,
          prefix: text.slice(Math.max(0, offset - 64), offset),
          suffix: text.slice(
            offset + passage.length,
            offset + passage.length + 64,
          ),
          offset,
          blocks: 1,
        },
        enclosing: text.replace(passage, '⟦' + passage + '⟧'),
        status: 'done',
      });
      note.title = 'On the list';
      note.sections.set(
        'Summary',
        'A note anchored to a list item, so the marker sits by the item.',
      );
      note.tags = ['list'];
      notesStore.set(note.id, note);
    }
  }
  const orphan = makeNote({
    passage: 'a passage that is not in this fixture at all',
    headings: [
      'Reading on a screen, without the strain',
      'A section that was rewritten',
    ],
    anchor: {
      block: 'bdeadbeef',
      line: 90,
      exact: 'a passage that is not in this fixture at all',
      prefix: '',
      suffix: '',
      offset: 0,
      blocks: 1,
    },
    enclosing:
      'The old paragraph carried ⟦a passage that is not in this fixture at all⟧, before the section was rewritten.',
    status: 'done',
  });
  orphan.title = 'A note whose passage is gone';
  orphan.sections.set(
    'Summary',
    'This note is an orphan: its passage was removed from the document.',
  );
  orphan.anchor.missingSince = noteNow();
  notesStore.set(orphan.id, orphan);
  log('notes', 'seeded ' + notesStore.size);
  postNotes();
}

function handleNoteMessage(command: string, args: unknown): boolean {
  switch (command) {
    case 'readAloudNoteCreate': {
      const request = parseNoteCreateArgs(args);
      if (!request) {
        log('dropped invalid readAloudNoteCreate message');
        return true;
      }
      const generate = flag('generate', true);
      const note = makeNote({
        passage: request.passage,
        headings: request.fields.breadcrumb,
        anchor: request.anchor,
        enclosing: request.fields.enclosing,
        status: request.source === 'help' || !generate ? 'done' : 'pending',
        source: request.source === 'help' ? 'help' : 'engine',
        explanation: request.explanation,
      });
      if (!generate && request.source !== 'help') {
        note.generated = { status: 'done' };
      }
      notesStore.set(note.id, note);
      log(
        'notes',
        'created ' +
          note.id +
          ' (' +
          request.passage.length +
          ' chars, ' +
          request.source +
          ')',
      );
      postNotes();
      if (request.source !== 'help' && generate) {
        generateNote(note.id, NOTES_DELAY_MS);
      }
      return true;
    }
    case 'readAloudNoteUpdate': {
      const request = parseNoteUpdateArgs(args);
      const note = request ? notesStore.get(request.noteId) : undefined;
      if (!request || !note) {
        log('dropped readAloudNoteUpdate');
        return true;
      }
      if (request.title !== undefined) {
        note.title = request.title;
        note.titleEdited = true;
      }
      if (request.tags !== undefined) {
        note.tags = request.tags;
      }
      if (request.myNote !== undefined) {
        note.myNote = request.myNote;
      }
      note.updated = noteNow();
      log(
        'notes',
        'updated ' +
          note.id +
          ' (' +
          Object.keys(request)
            .filter((k) => k !== 'sourceUri' && k !== 'noteId')
            .join(', ') +
          ')',
      );
      if (request.myNote === undefined) {
        postNotes();
      }
      return true;
    }
    case 'readAloudNoteDelete': {
      const request = parseNoteDeleteArgs(args);
      if (!request || !notesStore.has(request.noteId)) {
        return true;
      }
      const timer = window.setTimeout(() => {
        notesDeleting.delete(request.noteId);
        notesStore.delete(request.noteId);
        log('notes', 'trashed ' + request.noteId);
        postNotes();
      }, 6000);
      notesDeleting.set(request.noteId, timer);
      log('notes', 'deleting ' + request.noteId);
      postNotes();
      return true;
    }
    case 'readAloudNoteUndoDelete': {
      const request = parseNoteUndoDeleteArgs(args);
      const timer = request ? notesDeleting.get(request.noteId) : undefined;
      if (request && timer !== undefined) {
        window.clearTimeout(timer);
        notesDeleting.delete(request.noteId);
        log('notes', 'undo delete ' + request.noteId);
      }
      postNotes();
      return true;
    }
    case 'readAloudNoteRegenerate': {
      const request = parseNoteRegenerateArgs(args);
      const note = request ? notesStore.get(request.noteId) : undefined;
      if (!request || !note) {
        return true;
      }
      note.generated = { ...note.generated, status: 'pending' };
      note.updated = noteNow();
      log(
        'notes',
        'regenerating ' +
          note.id +
          (request.fields ? ' (fresh fields)' : ' (stored context)'),
      );
      postNotes();
      generateNote(note.id, NOTES_DELAY_MS);
      return true;
    }
    case 'readAloudNoteReattach': {
      const request = parseNoteReattachArgs(args);
      const note = request ? notesStore.get(request.noteId) : undefined;
      if (!request || !note) {
        return true;
      }
      if (!note.anchor.original) {
        note.anchor.original = {
          block: note.anchor.block,
          line: note.anchor.line,
        };
      }
      note.anchor.current = {
        block: request.anchor.block,
        line: request.anchor.line,
      };
      delete note.anchor.missingSince;
      note.anchor.lastSeen = noteNow();
      note.document.headings = request.breadcrumb;
      note.updated = noteNow();
      log('notes', 'reattached ' + note.id);
      postNotes();
      return true;
    }
    case 'readAloudNoteOpen': {
      const request = parseNoteOpenArgs(args);
      log(
        'notes',
        'open ' +
          (request ? request.target + ' for ' + request.noteId : 'invalid'),
      );
      return true;
    }
    case 'readAloudNoteCopy': {
      const request = parseNoteCopyArgs(args);
      log('notes', 'copy ' + (request ? request.noteId : 'invalid'));
      return true;
    }
    case 'readAloudNoteAnchors': {
      const request = parseNoteAnchorsArgs(args);
      if (!request) {
        log('dropped invalid readAloudNoteAnchors message');
        return true;
      }
      const found = request.anchors.filter((a) => a.found).length;
      for (const report of request.anchors) {
        const note = notesStore.get(report.noteId);
        if (!note) {
          continue;
        }
        if (report.found) {
          delete note.anchor.missingSince;
          note.anchor.lastSeen = noteNow();
          if (report.block && report.block !== note.anchor.block) {
            note.anchor.current = {
              block: report.block,
              line: report.line ?? null,
            };
          } else {
            delete note.anchor.current;
          }
        } else if (!note.anchor.missingSince) {
          note.anchor.missingSince = noteNow();
        }
      }
      lastAnchorsReport = request.anchors;
      log('notes', 'anchors ' + found + '/' + request.anchors.length);
      return true;
    }
    case 'readAloudNotesShowAll':
      log(
        'notes',
        parseNotesShowAllArgs(args)
          ? 'show all (the view would focus)'
          : 'invalid show all',
      );
      return true;
    default:
      return false;
  }
}

let lastAnchorsReport: {
  noteId: string;
  found: boolean;
  block?: string;
  line?: number | null;
}[] = [];

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

/**
 * Replace the root's children with a fresh copy, as an `updateHtml` would.
 * `rerender('edited')` (12 §18) replaces it with a copy in which the noted
 * paragraph has a sentence added before the passage and the first list item
 * has moved into the next list, so anchoring steps 2 and 3 run.
 */
function rerender(variant?: string): number {
  const target = root();
  if (!target) {
    return 0;
  }
  let html = fixtureHtml;
  if (variant === 'edited') {
    const scratch = document.createElement('div');
    scratch.innerHTML = fixtureHtml;
    const paragraph = Array.from(scratch.children).find(
      (el) =>
        el.tagName === 'P' &&
        (el.textContent ?? '').includes('sixty-six is the figure'),
    );
    if (paragraph && paragraph.firstChild) {
      paragraph.insertBefore(
        document.createTextNode('An edit made after the note was saved. '),
        paragraph.firstChild,
      );
    }
    const lists = Array.from(scratch.children).filter(
      (el) => el.tagName === 'UL',
    );
    if (lists.length >= 2 && lists[0].firstElementChild) {
      lists[1].appendChild(lists[0].firstElementChild);
    }
    html = scratch.innerHTML;
  }
  target.innerHTML = html;
  log(
    'rerender',
    target.children.length +
      ' elements' +
      (variant ? ' (' + variant + ')' : ''),
  );
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
    notes: notesChecks(target),
    classroom: classroomChecks(),
    config: { ...config },
  };
}

/**
 * `color(srgb r g b / a)` and `rgba()` as Chromium reports a translucent ink,
 * composited over `surface`, so the contrast of a 55% ink can be measured.
 */
function compositeOver(color: string, surface: string): string {
  const rgb = hexToRgb(surface) ?? [255, 255, 255];
  let channels: [number, number, number] | null = null;
  let alpha = 1;
  const srgb =
    /^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\)/.exec(
      color,
    );
  if (srgb) {
    channels = [
      Math.round(Number(srgb[1]) * 255),
      Math.round(Number(srgb[2]) * 255),
      Math.round(Number(srgb[3]) * 255),
    ];
    alpha = srgb[4] === undefined ? 1 : Number(srgb[4]);
  } else {
    const rgba = /^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/.exec(
      color,
    );
    if (rgba) {
      channels = [Number(rgba[1]), Number(rgba[2]), Number(rgba[3])];
      alpha = rgba[4] === undefined ? 1 : Number(rgba[4]);
    }
  }
  if (!channels) {
    return color;
  }
  const mixed = channels.map((c, i) =>
    Math.round(c * alpha + rgb[i] * (1 - alpha)),
  );
  return `rgb(${mixed[0]}, ${mixed[1]}, ${mixed[2]})`;
}

/** 13 §18 — the cluster's width and rows, the sheets' width and measure, contrasts, the bar's count. */
function classroomChecks(): Record<string, unknown> {
  const float = document.querySelector('.mpe-ra-float') as HTMLElement | null;
  const floatRect =
    float && !float.hidden ? float.getBoundingClientRect() : null;
  const floatButtons = float
    ? (
        Array.from(float.querySelectorAll('.mpe-ra-float-btn')) as HTMLElement[]
      ).filter((b) => !b.hidden)
    : [];
  const tops = new Set(
    floatButtons.map((b) => Math.round(b.getBoundingClientRect().top)),
  );
  const column = root();
  const columnRect = column ? column.getBoundingClientRect() : null;
  const sheet = document.querySelector(
    '.mpe-ra-classroom',
  ) as HTMLElement | null;
  const moduleSheet = document.querySelector(
    '.mpe-ra-module',
  ) as HTMLElement | null;
  const measureOf = (el: HTMLElement | null) => {
    if (!el || el.hidden) {
      return null;
    }
    const style = getComputedStyle(el);
    return {
      width: el.getBoundingClientRect().width,
      fontSize: style.fontSize,
      lineHeight: style.lineHeight,
      maxHeight: style.maxHeight,
    };
  };
  const row = document.querySelector(
    '.mpe-ra-lever-row[aria-checked="true"]',
  ) as HTMLElement | null;
  const surface = sheet ? getComputedStyle(sheet).backgroundColor : '';
  const rowStyle = row ? getComputedStyle(row) : null;
  const badge = document.querySelector(
    '.mpe-ra-bar-classroom-badge',
  ) as HTMLElement | null;
  const badgeStyle = badge && !badge.hidden ? getComputedStyle(badge) : null;
  return {
    cluster: floatRect
      ? {
          width: floatRect.width,
          rows: tops.size,
          buttons: floatButtons.length,
          insideColumn: columnRect
            ? floatRect.right <= columnRect.right + 1
            : null,
        }
      : null,
    sheet: measureOf(sheet),
    moduleSheet: measureOf(moduleSheet),
    lever: rowStyle
      ? {
          text: rowStyle.color,
          ring: rowStyle.borderColor,
          surface,
          textContrast: contrast(
            rowStyle.color,
            compositeOver(surface, surface),
          ),
          ringContrast: contrast(
            rowStyle.borderColor,
            compositeOver(surface, surface),
          ),
        }
      : null,
    badge: badgeStyle
      ? {
          text: badgeStyle.color,
          background: badgeStyle.backgroundColor,
          contrast: contrast(badgeStyle.color, badgeStyle.backgroundColor),
        }
      : null,
    barButtons: Array.from(
      document.querySelectorAll('.mpe-ra-bar > .mpe-ra-bar-btn'),
    ).filter((b) => !(b as HTMLElement).hidden).length,
    state: {
      sheetOpen: !!sheet && !sheet.hidden,
      details:
        document.querySelector('.mpe-ra-classroom-details')?.textContent ??
        null,
      chapterRows: document.querySelectorAll(
        '.mpe-ra-classroom-card .mpe-ra-chapter-row',
      ).length,
      message:
        document.querySelector('.mpe-ra-bar-status')?.textContent ?? null,
    },
  };
}

/** 12 §18 — the notes report: markers, ranges, contrast, the sheet, the pass. */
function notesChecks(target: HTMLElement | null): Record<string, unknown> {
  const markers = Array.from(
    document.querySelectorAll('.mpe-ra-note-marker'),
  ) as HTMLElement[];
  const highlights = (
    CSS as unknown as { highlights?: Map<string, Set<Range>> }
  ).highlights;
  const highlight = highlights ? highlights.get('mpe-ra-note') : undefined;
  const ranges = highlight
    ? Array.from(highlight as unknown as Iterable<Range>)
    : [];
  const firstRange = ranges[0];
  const markerRows = markers.map((marker) => {
    const block = marker.parentElement as HTMLElement;
    const blockRect = block.getBoundingClientRect();
    const rect = marker.getBoundingClientRect();
    const style = getComputedStyle(marker);
    const range = ranges.find((r) => block.contains(r.startContainer));
    const lineRect = range ? range.getClientRects()[0] : undefined;
    const surface = target
      ? getComputedStyle(target).backgroundColor
      : 'rgb(255,255,255)';
    const ink = style.color;
    const badge = marker.querySelector(
      '.mpe-ra-note-count',
    ) as HTMLElement | null;
    return {
      noteId: marker.getAttribute('data-mpe-ra-note'),
      block: block.tagName.toLowerCase() + (block.id ? '#' + block.id : ''),
      right: style.right,
      rightPx: Math.round(blockRect.right - rect.right),
      top: Math.round(rect.top - blockRect.top),
      lineTop: lineRect ? Math.round(lineRect.top - blockRect.top) : null,
      width: rect.width,
      height: rect.height,
      count: badge ? badge.textContent : null,
      title: marker.getAttribute('title'),
      pending: marker.classList.contains('is-pending'),
      active: marker.classList.contains('is-active'),
      ink,
      inkComposited: compositeOver(ink, surface),
      inkOnSurface: contrast(compositeOver(ink, surface), surface),
      badge: badge
        ? {
            fg: getComputedStyle(badge).color,
            bg: getComputedStyle(badge).backgroundColor,
            contrast: contrast(
              getComputedStyle(badge).color,
              getComputedStyle(badge).backgroundColor,
            ),
          }
        : null,
    };
  });
  const sheet = document.querySelector('.mpe-ra-note') as HTMLElement | null;
  const body = document.querySelector(
    '.mpe-ra-note-body',
  ) as HTMLElement | null;
  const textarea = document.querySelector(
    '.mpe-ra-note-textarea',
  ) as HTMLTextAreaElement | null;
  const list = document.querySelector(
    '.mpe-ra-notes-list',
  ) as HTMLElement | null;
  const markInk =
    firstRange && firstRange.startContainer.parentElement
      ? getComputedStyle(firstRange.startContainer.parentElement)
          .getPropertyValue('--mpe-ra-note-ink')
          .trim()
      : null;
  return {
    markers: markerRows,
    gutter: target ? target.classList.contains('mpe-ra-notes-gutter') : null,
    ranges: ranges.length,
    rangeTexts: ranges.map((r) => r.toString().slice(0, 40)),
    markInk,
    sheet: sheet
      ? {
          hidden: sheet.hidden,
          width: getComputedStyle(sheet).width,
          fontSize: getComputedStyle(sheet).fontSize,
          bodyWidth: body ? getComputedStyle(body).width : null,
          bodyCharsPerLine: body ? charsPerLine(body) : null,
          details:
            (
              document.querySelector(
                '.mpe-ra-note-details',
              ) as HTMLElement | null
            )?.textContent ?? null,
          textareaRows: textarea ? textarea.rows : null,
          textareaHeight: textarea ? getComputedStyle(textarea).height : null,
          tags: Array.from(document.querySelectorAll('.mpe-ra-note-tag')).map(
            (t) => t.getAttribute('data-tag'),
          ),
          pager:
            (
              document.querySelector(
                '.mpe-ra-note-pager-label',
              ) as HTMLElement | null
            )?.textContent ?? null,
          banner: !(
            document.querySelector('.mpe-ra-note-banner') as HTMLElement | null
          )?.hidden,
        }
      : null,
    list: list
      ? {
          hidden: list.hidden,
          rows: Array.from(document.querySelectorAll('.mpe-ra-notes-row')).map(
            (row) => ({
              title:
                row.querySelector('.mpe-ra-notes-row-title > span')
                  ?.textContent ?? '',
              badge:
                row.querySelector('.mpe-ra-notes-badge')?.textContent ?? null,
              meta:
                row.querySelector('.mpe-ra-notes-row-meta')?.textContent ?? '',
            }),
          ),
        }
      : null,
    barBadge:
      (document.querySelector('.mpe-ra-bar-badge') as HTMLElement | null)
        ?.textContent ?? null,
    chip:
      (document.querySelector('.mpe-ra-note-chip-text') as HTMLElement | null)
        ?.textContent ?? null,
    chipHidden:
      (document.querySelector('.mpe-ra-note-chip') as HTMLElement | null)
        ?.hidden ?? null,
    lastAnchorsReport,
    stored: Array.from(notesStore.values()).map((note) => ({
      id: note.id,
      title: note.title,
      status: note.generated.status,
      tags: note.tags,
      myNote: note.myNote,
      missingSince: note.anchor.missingSince ?? null,
      current: note.anchor.current ?? null,
    })),
    passMs:
      (window as unknown as { mpeReadAloudNotesPassMs?: number })
        .mpeReadAloudNotesPassMs ?? null,
  };
}

(window as unknown as { mpeHarness: unknown }).mpeHarness = {
  checks,
  rerender,
  charsPerLine,
  events,
  config,
  notes: notesStore,
  postNotes,
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
  void loadFixture().then(() => {
    // The player has decorated the fixture by now; the canned notes key on it.
    window.setTimeout(seedNotes, 100);
    window.setTimeout(seedModule, 150);
  });
  void audioMode();
});

log('shim', 'ready ' + JSON.stringify(Object.fromEntries(params.entries())));
