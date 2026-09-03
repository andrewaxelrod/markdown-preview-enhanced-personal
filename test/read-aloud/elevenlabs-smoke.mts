/**
 * ElevenLabs read-aloud API smoke test - spec.md section 7 ("API smoke test"), milestone M0.
 *
 * Answers questions 1-5 of resources/elevenlabs.resource.v2.md section 15:
 *   Q1  Does eleven_v3 return `alignment` from /with-timestamps, and does
 *       alignment.characters.join('') equal the input?
 *   Q2  Does alignment.characters.join('') reproduce the submitted text exactly for
 *       straight/curly quotes, an em-dash, numerals, a URL, inline code and CJK?
 *   Q3  When is `alignment` null? (one-word input, punctuation-only input)
 *   Q4  Does GET /v2/voices?page_size=1 return a usable voice? (tier from
 *       GET /v1/user/subscription)
 *   Q5  Is the `character-cost` response header present on the with-timestamps call,
 *       and do previous_text/next_text change it?
 *
 * Run from the repo root:
 *   node --env-file=.env test/read-aloud/elevenlabs-smoke.mts
 *
 * Node 24 runs .mts under native type stripping, so nothing here may need a
 * transform: no enums, no namespaces, no parameter properties, and no imports -
 * the script has zero dependencies and uses plain `fetch` (decision D1,
 * spec.md section 10.1: fetch-1.82, no SDK).
 *
 * Structure note: everything lives inside `main()`. tsconfig.json includes
 * `test/**` with `"module": "commonjs"`, so a top-level `await` here would fail
 * `npx tsc --noEmit -p .` with TS1378.
 *
 * Privacy: the API key is read from process.env and is never printed, and no
 * audio is written to disk - only the base64 length is reported.
 *
 * Exit codes: 0 all questions answered without a failure, 1 at least one FAIL,
 * 2 no API key, 3 the run aborted before it could answer.
 */

type Verdict = 'pass' | 'fail' | 'partial';

interface QuestionResult {
  id: string;
  verdict: Verdict;
  evidence: string;
}

interface CallHeaders {
  requestId: string | null;
  region: string | null;
  characterCost: string | null;
  concurrentRequests: string | null;
}

interface HttpOutcome {
  ok: boolean;
  status: number;
  headers: CallHeaders;
  json: unknown;
  rawLength: number;
  elapsedMs: number;
  transportError?: string;
}

interface TtsRequest {
  label: string;
  apiKey: string;
  voiceId: string;
  modelId: string;
  text: string;
  previousText?: string;
  nextText?: string;
}

interface Ledger {
  spent: number;
}

type AlignmentState = 'present' | 'null' | 'absent' | 'malformed';

interface AlignmentInfo {
  state: AlignmentState;
  characters?: string[];
  startCount?: number;
  endCount?: number;
}

interface RoundTrip {
  matches: boolean;
  detail: string;
}

interface VoicePick {
  voiceId: string;
  name: string;
  hasMore: string;
}

interface SubscriptionInfo {
  tier: string;
  status: string;
  used: string;
  limit: string;
}

// --- Constants (R2 sections 4.1, 4.6, 7.2, 8.1, 8.5, 10.1) -----------------

const API_BASE = 'https://api.elevenlabs.io';
const OUTPUT_FORMAT = 'mp3_44100_128';
const DEFAULT_MODEL = 'eleven_multilingual_v2';
const V3_MODEL = 'eleven_v3';
const REQUEST_TIMEOUT_MS = 60000;

/** Hard cap on characters sent to the API across the whole run (spec section 7). */
const CHARACTER_BUDGET = 1500;

const EMPTY_HEADERS: CallHeaders = {
  requestId: null,
  region: null,
  characterCost: null,
  concurrentRequests: null,
};

const SDK_CAVEAT =
  'REST-header result only: the SDK half of R2 section 15 item 5 (.withRawResponse() on convertWithTimestamps) is NOT tested by this fetch-based script, so that half stays open.';

const Q1_TEXT = 'Version three timestamps, please.';

const Q2_TEXT =
  'The "straight" and “curly” quotes — an em-dash — with v2.5, 2026-09-01 and $1,000. See https://example.com/read-aloud, then run `pnpm check:all`. 这是一个简短的中文句子。';

const Q3_ONE_WORD = 'Hello';
const Q3_PUNCTUATION = '...';

const Q5_TEXT = 'Read aloud keeps the prosody steady across blocks.';
const Q5_PREVIOUS =
  'The previous block ended right here, so the model has something to lean back on for prosody and pacing.';
const Q5_NEXT =
  'The next block starts right here, so the model has somewhere to lean forward into for prosody and pacing.';

// --- Small unknown-JSON helpers --------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
    return value as string[];
  }
  return undefined;
}

// --- HTTP -------------------------------------------------------------------

function headersOf(res: Response): CallHeaders {
  return {
    requestId: res.headers.get('request-id'),
    region: res.headers.get('x-region'),
    characterCost: res.headers.get('character-cost'),
    concurrentRequests: res.headers.get('current-concurrent-requests'),
  };
}

function formatHeaders(headers: CallHeaders): string {
  const show = (value: string | null): string => value ?? '(absent)';
  return [
    `request-id=${show(headers.requestId)}`,
    `x-region=${show(headers.region)}`,
    `character-cost=${show(headers.characterCost)}`,
    `current-concurrent-requests=${show(headers.concurrentRequests)}`,
  ].join(' ');
}

function logCall(label: string, outcome: HttpOutcome): void {
  const status =
    outcome.status === 0
      ? `transport-error (${outcome.transportError ?? 'unknown'})`
      : `HTTP ${outcome.status}`;
  console.log(
    `[call] ${label}: ${status} in ${outcome.elapsedMs} ms, ${outcome.rawLength} bytes; ${formatHeaders(outcome.headers)}`,
  );
}

async function httpJson(
  label: string,
  url: string,
  apiKey: string,
  postBody?: string,
): Promise<HttpOutcome> {
  const started = Date.now();
  try {
    const init: RequestInit =
      postBody === undefined
        ? {
            method: 'GET',
            headers: { 'xi-api-key': apiKey },
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          }
        : {
            method: 'POST',
            headers: {
              'xi-api-key': apiKey,
              'Content-Type': 'application/json',
            },
            body: postBody,
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          };
    const res = await fetch(url, init);
    const raw = await res.text();
    let json: unknown;
    try {
      json = JSON.parse(raw) as unknown;
    } catch {
      json = undefined;
    }
    const outcome: HttpOutcome = {
      ok: res.ok,
      status: res.status,
      headers: headersOf(res),
      json,
      rawLength: raw.length,
      elapsedMs: Date.now() - started,
    };
    logCall(label, outcome);
    return outcome;
  } catch (error: unknown) {
    const outcome: HttpOutcome = {
      ok: false,
      status: 0,
      headers: EMPTY_HEADERS,
      json: undefined,
      rawLength: 0,
      elapsedMs: Date.now() - started,
      transportError: error instanceof Error ? error.message : String(error),
    };
    logCall(label, outcome);
    return outcome;
  }
}

/** Error body shape is `{ detail: { type, code, message, request_id, param } }` (R2 section 9.1). */
function describeFailure(call: HttpOutcome): string {
  if (call.status === 0) {
    return `transport error: ${call.transportError ?? 'unknown'}`;
  }
  const root = asRecord(call.json);
  const detail = root === undefined ? undefined : asRecord(root.detail);
  if (detail === undefined) {
    return `HTTP ${call.status} with no parsable detail object`;
  }
  return [
    `HTTP ${call.status}`,
    `type=${asString(detail.type) ?? '?'}`,
    `code=${asString(detail.code) ?? '?'}`,
    `param=${asString(detail.param) ?? '-'}`,
    `request_id=${asString(detail.request_id) ?? '?'}`,
    `message=${JSON.stringify(asString(detail.message) ?? '')}`,
  ].join(' ');
}

// --- Response readers -------------------------------------------------------

function readAlignment(root: Record<string, unknown> | undefined): AlignmentInfo {
  if (root === undefined || !('alignment' in root) || root.alignment === undefined) {
    return { state: 'absent' };
  }
  if (root.alignment === null) {
    return { state: 'null' };
  }
  const alignment = asRecord(root.alignment);
  if (alignment === undefined) {
    return { state: 'malformed' };
  }
  const characters = asStringArray(alignment.characters);
  if (characters === undefined) {
    return { state: 'malformed' };
  }
  const starts = alignment.character_start_times_seconds;
  const ends = alignment.character_end_times_seconds;
  return {
    state: 'present',
    characters,
    startCount: Array.isArray(starts) ? starts.length : undefined,
    endCount: Array.isArray(ends) ? ends.length : undefined,
  };
}

function compareRoundTrip(sent: string, characters: string[]): RoundTrip {
  const joined = characters.join('');
  if (joined === sent) {
    return { matches: true, detail: `join('') === input over ${sent.length} chars` };
  }
  const shortest = Math.min(joined.length, sent.length);
  let index = 0;
  while (index < shortest && joined[index] === sent[index]) {
    index += 1;
  }
  const from = Math.max(0, index - 12);
  const sentWindow = JSON.stringify(sent.slice(from, index + 12));
  const gotWindow = JSON.stringify(joined.slice(from, index + 12));
  return {
    matches: false,
    detail: `join('') !== input: first divergence at index ${index} (sent ${sent.length} chars, got ${joined.length}); sent=${sentWindow} got=${gotWindow}`,
  };
}

function firstVoice(json: unknown): VoicePick | undefined {
  const root = asRecord(json);
  if (root === undefined) {
    return undefined;
  }
  const list = root.voices;
  if (!Array.isArray(list) || list.length === 0) {
    return undefined;
  }
  const first = asRecord(list[0]);
  if (first === undefined) {
    return undefined;
  }
  const voiceId = asString(first.voice_id);
  if (voiceId === undefined || voiceId === '') {
    return undefined;
  }
  return {
    voiceId,
    name: asString(first.name) ?? '(unnamed)',
    hasMore: String(root.has_more),
  };
}

function readSubscription(json: unknown): SubscriptionInfo {
  const root = asRecord(json);
  if (root === undefined) {
    return {
      tier: '(unavailable)',
      status: '(unavailable)',
      used: '?',
      limit: '?',
    };
  }
  return {
    tier: asString(root.tier) ?? '(absent)',
    status: asString(root.status) ?? '(absent)',
    used: String(asNumber(root.character_count) ?? '?'),
    limit: String(asNumber(root.character_limit) ?? '?'),
  };
}

// --- The one call we care about (R2 sections 4.1, 4.6) ----------------------

async function postWithTimestamps(
  req: TtsRequest,
  ledger: Ledger,
): Promise<HttpOutcome> {
  const cost =
    req.text.length +
    (req.previousText === undefined ? 0 : req.previousText.length) +
    (req.nextText === undefined ? 0 : req.nextText.length);
  if (ledger.spent + cost > CHARACTER_BUDGET) {
    throw new Error(
      `character budget exceeded before "${req.label}": ${ledger.spent} + ${cost} > ${CHARACTER_BUDGET}`,
    );
  }
  ledger.spent += cost;

  const body: Record<string, unknown> = {
    text: req.text,
    model_id: req.modelId,
    apply_text_normalization: 'auto',
  };
  if (req.previousText !== undefined) {
    body.previous_text = req.previousText;
  }
  if (req.nextText !== undefined) {
    body.next_text = req.nextText;
  }

  const url = `${API_BASE}/v1/text-to-speech/${encodeURIComponent(req.voiceId)}/with-timestamps?output_format=${OUTPUT_FORMAT}`;
  const label = `${req.label} [model=${req.modelId} chars=${cost} running=${ledger.spent}/${CHARACTER_BUDGET}]`;
  const outcome = await httpJson(label, url, req.apiKey, JSON.stringify(body));

  const root = asRecord(outcome.json);
  const audio = root === undefined ? undefined : asString(root.audio_base64);
  const info = readAlignment(root);
  const audioText =
    audio === undefined ? 'absent' : `${audio.length} base64 chars`;
  const charText =
    info.characters === undefined ? '' : ` (${info.characters.length} characters)`;
  console.log(
    `        audio_base64=${audioText} alignment=${info.state}${charText}`,
  );
  if (!outcome.ok) {
    console.log(`        error: ${describeFailure(outcome)}`);
  }
  return outcome;
}

// --- Judges -----------------------------------------------------------------

function judgeRoundTrip(
  id: string,
  prefix: string,
  sent: string,
  call: HttpOutcome,
  mismatchVerdict: Verdict,
): QuestionResult {
  if (!call.ok) {
    return { id, verdict: 'fail', evidence: `${prefix}: ${describeFailure(call)}` };
  }
  const info = readAlignment(asRecord(call.json));
  if (info.state !== 'present' || info.characters === undefined) {
    return {
      id,
      verdict: 'fail',
      evidence: `${prefix}: HTTP ${call.status} but alignment is ${info.state}; ${formatHeaders(call.headers)}`,
    };
  }
  const roundTrip = compareRoundTrip(sent, info.characters);
  const shape = `characters=${info.characters.length} start_times=${info.startCount ?? '?'} end_times=${info.endCount ?? '?'}`;
  return {
    id,
    verdict: roundTrip.matches ? 'pass' : mismatchVerdict,
    evidence: `${prefix}: alignment present, ${shape}, ${roundTrip.detail}; ${formatHeaders(call.headers)}`,
  };
}

function describeAlignmentOutcome(sent: string, call: HttpOutcome): string {
  if (!call.ok) {
    return `${JSON.stringify(sent)} -> ${describeFailure(call)}`;
  }
  const info = readAlignment(asRecord(call.json));
  if (info.characters === undefined) {
    return `${JSON.stringify(sent)} -> HTTP ${call.status}, alignment ${info.state}`;
  }
  const roundTrip = compareRoundTrip(sent, info.characters);
  return `${JSON.stringify(sent)} -> HTTP ${call.status}, alignment ${info.state}, characters=${info.characters.length}, round-trip ${roundTrip.matches ? 'exact' : 'MISMATCH'}`;
}

function judgeAlignmentPresence(
  oneWord: HttpOutcome,
  punctuation: HttpOutcome,
): QuestionResult {
  const answered = oneWord.status !== 0 && punctuation.status !== 0;
  return {
    id: 'Q3',
    verdict: answered ? 'pass' : 'fail',
    evidence: `one-word ${describeAlignmentOutcome(Q3_ONE_WORD, oneWord)} | punctuation-only ${describeAlignmentOutcome(Q3_PUNCTUATION, punctuation)}${answered ? '' : ' | at least one call never reached the API, so the question is unanswered'}`,
  };
}

function judgeCharacterCost(
  bare: HttpOutcome,
  contextual: HttpOutcome,
): QuestionResult {
  const bareCost = bare.headers.characterCost;
  const contextCost = contextual.headers.characterCost;
  if (bareCost === null) {
    return {
      id: 'Q5',
      verdict: 'fail',
      evidence: `character-cost header absent on the with-timestamps call (HTTP ${bare.status}); ${formatHeaders(bare.headers)}. ${SDK_CAVEAT}`,
    };
  }
  const contextChars = Q5_PREVIOUS.length + Q5_NEXT.length;
  const comparison =
    contextCost === null
      ? 'the context call returned no character-cost header, so the previous_text/next_text billing question is unanswered'
      : `character-cost=${bareCost} without context vs ${contextCost} with ${contextChars} chars of previous_text/next_text on the same ${Q5_TEXT.length}-char text -> context ${bareCost === contextCost ? 'does NOT change the cost' : 'DOES change the cost'}`;
  return {
    id: 'Q5',
    verdict: 'partial',
    evidence: `character-cost header present on the REST with-timestamps call; ${comparison}. ${SDK_CAVEAT}`,
  };
}

// --- Main -------------------------------------------------------------------

async function main(): Promise<void> {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (apiKey === undefined || apiKey.trim() === '') {
    console.error(
      'ELEVENLABS_API_KEY is not set. Put it in a gitignored .env at the repo root:',
    );
    console.error('  ELEVENLABS_API_KEY=<your ElevenLabs key>');
    console.error('then run, from the repo root:');
    console.error(
      '  node --env-file=.env test/read-aloud/elevenlabs-smoke.mts',
    );
    process.exit(2);
  }

  const ledger: Ledger = { spent: 0 };
  const results: QuestionResult[] = [];
  const notes: string[] = [
    SDK_CAVEAT,
    'Decision D1 (spec.md section 10.1) is fetch-1.82 / no SDK, so this script deliberately uses plain fetch and adds no dependency.',
    'The voice is resolved at runtime from GET /v2/voices?page_size=1 (R2 section 7.1/7.2); no voice id is hard-coded.',
    'The API key is read from process.env.ELEVENLABS_API_KEY and is never printed; no audio is written to disk.',
  ];

  console.log(
    'ElevenLabs read-aloud smoke test - spec.md section 7 / R2 section 15 items 1-5',
  );
  console.log(
    `base=${API_BASE} output_format=${OUTPUT_FORMAT} default_model=${DEFAULT_MODEL} budget=${CHARACTER_BUDGET} chars`,
  );
  console.log('');

  // Q4: resolve a voice at runtime, and record the account tier.
  const voicesOutcome = await httpJson(
    'Q4 GET /v2/voices?page_size=1',
    `${API_BASE}/v2/voices?page_size=1`,
    apiKey,
  );
  const subscriptionOutcome = await httpJson(
    'Q4 GET /v1/user/subscription',
    `${API_BASE}/v1/user/subscription`,
    apiKey,
  );
  const voice = firstVoice(voicesOutcome.json);
  const subscription = readSubscription(subscriptionOutcome.json);
  const subscriptionText = `subscription (HTTP ${subscriptionOutcome.status}) tier=${subscription.tier} status=${subscription.status} characters=${subscription.used}/${subscription.limit}`;

  if (voice === undefined) {
    results.push({
      id: 'Q4',
      verdict: 'fail',
      evidence: `GET /v2/voices?page_size=1 returned no usable voice: ${describeFailure(voicesOutcome)}; ${subscriptionText}`,
    });
    for (const id of ['Q1', 'Q2', 'Q3', 'Q5']) {
      results.push({
        id,
        verdict: 'fail',
        evidence:
          'not attempted: no voice could be resolved from GET /v2/voices?page_size=1, and no voice id may be hard-coded (R2 section 7.1)',
      });
    }
  } else {
    results.push({
      id: 'Q4',
      verdict: 'pass',
      evidence: `GET /v2/voices?page_size=1 -> HTTP ${voicesOutcome.status}, voices[0].voice_id=${voice.voiceId} name=${JSON.stringify(voice.name)} has_more=${voice.hasMore}; ${subscriptionText}`,
    });

    // Q1: does eleven_v3 return a usable alignment at all?
    const q1Call = await postWithTimestamps(
      {
        label: 'Q1 eleven_v3 with-timestamps',
        apiKey,
        voiceId: voice.voiceId,
        modelId: V3_MODEL,
        text: Q1_TEXT,
      },
      ledger,
    );
    results.push(
      judgeRoundTrip(
        'Q1',
        `${V3_MODEL} on ${Q1_TEXT.length} chars`,
        Q1_TEXT,
        q1Call,
        'partial',
      ),
    );

    // Q2: does the alignment reproduce awkward markdown text exactly?
    const q2Call = await postWithTimestamps(
      {
        label: 'Q2 mixed punctuation/numerals/URL/code/CJK',
        apiKey,
        voiceId: voice.voiceId,
        modelId: DEFAULT_MODEL,
        text: Q2_TEXT,
      },
      ledger,
    );
    results.push(
      judgeRoundTrip(
        'Q2',
        `${DEFAULT_MODEL} on ${Q2_TEXT.length} chars (straight + curly quotes, em-dash, v2.5, 2026-09-01, $1,000, URL, inline code, CJK)`,
        Q2_TEXT,
        q2Call,
        'fail',
      ),
    );

    // Q3: when is alignment null?
    const q3OneWord = await postWithTimestamps(
      {
        label: 'Q3a one-word input',
        apiKey,
        voiceId: voice.voiceId,
        modelId: DEFAULT_MODEL,
        text: Q3_ONE_WORD,
      },
      ledger,
    );
    const q3Punctuation = await postWithTimestamps(
      {
        label: 'Q3b punctuation-only input',
        apiKey,
        voiceId: voice.voiceId,
        modelId: DEFAULT_MODEL,
        text: Q3_PUNCTUATION,
      },
      ledger,
    );
    results.push(judgeAlignmentPresence(q3OneWord, q3Punctuation));

    // Q5: character-cost header, with and without previous_text/next_text.
    const q5Bare = await postWithTimestamps(
      {
        label: 'Q5a same text, no context',
        apiKey,
        voiceId: voice.voiceId,
        modelId: DEFAULT_MODEL,
        text: Q5_TEXT,
      },
      ledger,
    );
    const q5Contextual = await postWithTimestamps(
      {
        label: 'Q5b same text, previous_text + next_text',
        apiKey,
        voiceId: voice.voiceId,
        modelId: DEFAULT_MODEL,
        text: Q5_TEXT,
        previousText: Q5_PREVIOUS,
        nextText: Q5_NEXT,
      },
      ledger,
    );
    results.push(judgeCharacterCost(q5Bare, q5Contextual));
  }

  results.sort((a, b) => a.id.localeCompare(b.id));

  console.log('');
  console.log('-- Results (R2 section 15 items 1-5) --');
  for (const result of results) {
    console.log(
      `${result.id} ${result.verdict.toUpperCase().padEnd(7)} ${result.evidence}`,
    );
  }
  console.log('');
  console.log(
    `Characters sent (text + previous_text + next_text): ${ledger.spent} of ${CHARACTER_BUDGET}`,
  );

  const summary = {
    milestone: 'M0',
    source: 'resources/elevenlabs.resource.v2.md section 15 items 1-5',
    runAt: new Date().toISOString(),
    ran: true,
    apiBase: API_BASE,
    outputFormat: OUTPUT_FORMAT,
    models: { q1: V3_MODEL, q2q3q5: DEFAULT_MODEL },
    voiceId: voice === undefined ? null : voice.voiceId,
    voiceName: voice === undefined ? null : voice.name,
    subscriptionTier: subscription.tier,
    subscriptionStatus: subscription.status,
    charactersSpent: ledger.spent,
    results,
    notes,
  };
  console.log('');
  console.log('-- JSON summary --');
  console.log(JSON.stringify(summary, null, 2));

  process.exitCode = results.some((result) => result.verdict === 'fail') ? 1 : 0;
}

main().catch((error: unknown) => {
  console.error(
    `[abort] ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 3;
});
