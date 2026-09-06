import { spawn as nodeSpawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * The headless CLI that writes the explanation
 * (`featrues/04-help-module.md` §7).
 *
 * Node-only: `child_process` does not exist in the web bundle, so every path
 * here sits behind the controller's `isWebBuild` guard. No `vscode` import, so
 * the argv builder, the binary lookup and the run loop are unit-testable with
 * an injected `spawn`.
 *
 * Two rules the implementation must not lose:
 *
 * - **Never a shell for the engine.** The model, the effort and a custom argv
 *   go through as single argv elements, so nothing a setting contains can be
 *   word-split or expanded. The login-shell lookup of §7.3 is the one place a
 *   shell is used, and only with our own two constant binary names.
 * - **An empty `cwd`.** The child runs in a fresh directory under
 *   `os.tmpdir()`, so no project's `CLAUDE.md` or `AGENTS.md` is auto-loaded
 *   into the prompt and codex's read-only sandbox has nothing to read.
 */

export const HELP_ENGINES = ['claude', 'codex', 'custom'] as const;
export type HelpEngineId = (typeof HELP_ENGINES)[number];
export const DEFAULT_HELP_ENGINE: HelpEngineId = 'claude';

/** §7.1 — `--effort` for claude: the five levels the CLI accepts (2.1.259). */
export const CLAUDE_EFFORTS = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;
export type ClaudeEffort = (typeof CLAUDE_EFFORTS)[number];
export const DEFAULT_CLAUDE_EFFORT: ClaudeEffort = 'low';

/** The CLI's own aliases always mean its latest model of that name. */
export const CLAUDE_MODEL_ALIASES = [
  'fable',
  'opus',
  'sonnet',
  'haiku',
] as const;
export const DEFAULT_CLAUDE_MODEL = 'sonnet';
export const CLAUDE_MODEL_RE = /^(fable|opus|sonnet|haiku|claude-[a-z0-9.-]+)$/;

/**
 * §7.1 — codex's `ReasoningEffort` enum plus `default`, which omits the
 * override and lets the CLI's configured value answer. Not every model accepts
 * every level; a refused one is shown as the CLI's own error.
 */
export const CODEX_EFFORTS = [
  'default',
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
] as const;
export type CodexEffort = (typeof CODEX_EFFORTS)[number];
export const DEFAULT_CODEX_EFFORT: CodexEffort = 'low';

export const HELP_TIMEOUT_MIN_SECONDS = 15;
export const HELP_TIMEOUT_MAX_SECONDS = 300;
export const DEFAULT_HELP_TIMEOUT_SECONDS = 90;

/** How long a SIGTERMed child is given before SIGKILL (§7.2). */
export const KILL_GRACE_MS = 3000;

/** The login-shell lookup is a fallback, not a place to wait (§7.3). */
export const LOOKUP_TIMEOUT_MS = 5000;

/** How much of stderr an error message may carry (§4 "auth error"). */
export const STDERR_EXCERPT_CHARS = 300;

/** The name codex is told to write its answer to, inside the empty cwd. */
export const CODEX_ANSWER_FILE = 'answer.md';

export interface HelpEngineConfig {
  engine: HelpEngineId;
  claudeModel: string;
  claudeEffort: ClaudeEffort;
  codexModel: string;
  codexEffort: CodexEffort;
  /** `custom` only: argv, prompt on stdin, answer on stdout. */
  command: string[];
  timeoutSeconds: number;
  binaryPath: { claude?: string; codex?: string };
}

/** What the sheet's label and the log line name (§4, §7.1). */
export interface HelpEngineLabel {
  engine: HelpEngineId;
  model: string;
  effort: string;
}

export function engineLabel(config: HelpEngineConfig): HelpEngineLabel {
  if (config.engine === 'claude') {
    return {
      engine: 'claude',
      model: config.claudeModel || DEFAULT_CLAUDE_MODEL,
      effort: config.claudeEffort,
    };
  }
  if (config.engine === 'codex') {
    return {
      engine: 'codex',
      model: config.codexModel || 'default',
      effort: config.codexEffort,
    };
  }
  return { engine: 'custom', model: config.command[0] ?? '', effort: 'n/a' };
}

// ---------------------------------------------------------------------- argv

export interface HelpInvocation {
  /** The binary: an absolute path once §7.3 has resolved it. */
  file: string;
  args: string[];
  /** The whole prompt; written to stdin, which is then closed. */
  stdin: string;
  /** Where the answer is read from once the child exits cleanly. */
  answerFrom: 'claudeJson' | 'stdout' | 'file';
  /** `answerFrom: 'file'` — the path the child was told to write. */
  answerFile?: string;
}

/**
 * §7.2 — the argv of one request.
 *
 * claude: the system prompt replaces Claude Code's coding prompt, no tools,
 * nothing persisted, and the answer comes back as JSON. `--bare` is
 * deliberately *not* used: it restricts auth to `ANTHROPIC_API_KEY`, so a
 * subscription login would stop working, and `--tools ""` plus the replaced
 * system prompt already gives a plain completion.
 *
 * codex: `-` reads the prompt from stdin; there is no system-prompt flag, so
 * the two parts arrive as one document (§14.6). It cannot be told "no tools",
 * so `-s read-only` plus the empty cwd leaves it nothing to run against, and
 * the answer is the file `-o` names because stdout is progress.
 */
export function buildInvocation(
  config: HelpEngineConfig,
  binary: string,
  systemPrompt: string,
  userPrompt: string,
  cwd: string,
  codexPrompt: string,
): HelpInvocation {
  if (config.engine === 'claude') {
    return {
      file: binary,
      args: [
        '-p',
        '--output-format',
        'json',
        '--tools',
        '',
        '--no-session-persistence',
        '--disable-slash-commands',
        '--model',
        config.claudeModel || DEFAULT_CLAUDE_MODEL,
        '--effort',
        config.claudeEffort,
        '--system-prompt',
        systemPrompt,
      ],
      stdin: userPrompt,
      answerFrom: 'claudeJson',
    };
  }
  if (config.engine === 'codex') {
    const answerFile = path.join(cwd, CODEX_ANSWER_FILE);
    const args = [
      'exec',
      '-',
      '--ephemeral',
      '--skip-git-repo-check',
      '-s',
      'read-only',
      '-C',
      cwd,
      '--color',
      'never',
    ];
    // An empty model omits `-m`, so the CLI's configured default answers;
    // effort `default` omits the override for the same reason.
    if (config.codexModel) {
      args.push('-m', config.codexModel);
    }
    if (config.codexEffort !== 'default') {
      args.push('-c', `model_reasoning_effort=${config.codexEffort}`);
    }
    args.push('-o', answerFile);
    return {
      file: binary,
      args,
      stdin: codexPrompt,
      answerFrom: 'file',
      answerFile,
    };
  }
  // custom: the argv is the setting, verbatim. No model and no effort flag.
  return {
    file: config.command[0] ?? '',
    args: config.command.slice(1),
    stdin: codexPrompt,
    answerFrom: 'stdout',
  };
}

// --------------------------------------------------------------------- errors

export type HelpErrorCode =
  | 'engine_not_found'
  | 'engine_auth'
  | 'engine_timeout'
  | 'engine_failed'
  | 'engine_empty'
  | 'cancelled';

export class HelpEngineError extends Error {
  public readonly code: HelpErrorCode;
  public readonly retryable: boolean;

  constructor(code: HelpErrorCode, message: string, retryable: boolean) {
    super(message);
    this.name = 'HelpEngineError';
    this.code = code;
    this.retryable = retryable;
  }
}

const AUTH_HINTS = [
  'not logged in',
  'please log in',
  'please run /login',
  'invalid api key',
  'authentication',
  'unauthorized',
  'oauth token',
  'credentials',
  'forbidden',
];

function looksLikeAuthFailure(text: string): boolean {
  const lower = text.toLowerCase();
  return AUTH_HINTS.some((hint) => lower.includes(hint));
}

function excerpt(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > STDERR_EXCERPT_CHARS
    ? `${flat.slice(0, STDERR_EXCERPT_CHARS)}…`
    : flat;
}

// -------------------------------------------------------------- process glue

/** The slice of `child_process` this module uses; an injection point (T-13). */
export type SpawnFn = typeof nodeSpawn;

export interface HelpEngineDeps {
  spawn: SpawnFn;
  log: (line: string) => void;
  env: NodeJS.ProcessEnv;
}

export function defaultHelpEngineDeps(
  log: (line: string) => void,
): HelpEngineDeps {
  return { spawn: nodeSpawn, log, env: process.env };
}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Run one child to completion, feeding `stdin` and collecting both streams.
 * A timeout or an abort sends SIGTERM and, {@link KILL_GRACE_MS} later,
 * SIGKILL; either way the promise rejects with the matching
 * {@link HelpEngineError}.
 */
function runChild(
  deps: HelpEngineDeps,
  file: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; stdin?: string },
  timeoutMs: number,
  signal: AbortSignal | undefined,
  what: string,
): Promise<RunResult> {
  return new Promise<RunResult>((resolve, reject) => {
    let child: ReturnType<SpawnFn>;
    try {
      child = deps.spawn(file, args, {
        cwd: options.cwd,
        env: options.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      reject(
        new HelpEngineError(
          'engine_not_found',
          `Could not start ${what}: ${String(error)}`,
          false,
        ),
      );
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      if (timeoutTimer !== undefined) {
        clearTimeout(timeoutTimer);
      }
      if (killTimer !== undefined) {
        clearTimeout(killTimer);
      }
      if (signal) {
        signal.removeEventListener('abort', onAbort);
      }
    };

    const fail = (error: HelpEngineError) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    };

    /** SIGTERM now, SIGKILL after the grace period (§7.2). */
    const stop = () => {
      try {
        child.kill('SIGTERM');
      } catch {
        // Already gone.
      }
      killTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // Already gone.
        }
      }, KILL_GRACE_MS);
    };

    function onAbort() {
      stop();
      fail(new HelpEngineError('cancelled', '', false));
    }

    if (signal) {
      if (signal.aborted) {
        stop();
        fail(new HelpEngineError('cancelled', '', false));
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    if (timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        stop();
        fail(
          new HelpEngineError(
            'engine_timeout',
            `No answer after ${Math.round(timeoutMs / 1000)} s.`,
            true,
          ),
        );
      }, timeoutMs);
    }

    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout += String(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr += String(chunk);
    });
    child.on('error', (error: NodeJS.ErrnoException) => {
      const notFound =
        error && (error.code === 'ENOENT' || error.code === 'EACCES');
      fail(
        new HelpEngineError(
          notFound ? 'engine_not_found' : 'engine_failed',
          `${what}: ${error?.message ?? String(error)}`,
          !notFound,
        ),
      );
    });
    child.on('close', (code: number | null) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve({ code, stdout, stderr });
    });

    const stdin = child.stdin;
    if (stdin) {
      stdin.on('error', () => {
        // A child that exits before reading the prompt closes the pipe; the
        // `close` handler reports whatever it managed to say.
      });
      try {
        if (options.stdin) {
          stdin.write(options.stdin);
        }
        stdin.end();
      } catch {
        // Same as above.
      }
    }
  });
}

// ------------------------------------------------------------ §7.3 the binary

/** Resolution is cached for the life of the extension host, per binary name. */
const binaryCache = new Map<string, string>();

export function clearHelpBinaryCache(): void {
  binaryCache.clear();
}

function isExecutableFile(candidate: string): boolean {
  try {
    const stat = fs.statSync(candidate);
    if (!stat.isFile()) {
      return false;
    }
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** `command -v` without a shell: walk the PATH we were launched with. */
function findOnPath(name: string, env: NodeJS.ProcessEnv): string | undefined {
  const raw = env.PATH || env.Path || '';
  for (const dir of raw.split(path.delimiter)) {
    if (!dir) {
      continue;
    }
    const candidate = path.join(dir, name);
    if (isExecutableFile(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

/**
 * The login shell's own `command -v`. An extension host launched from the Dock
 * has the login shell's PATH only sometimes; on this machine `claude` lives in
 * `~/.local/bin` and `codex` under nvm's bin, neither of which is on a bare
 * PATH. `name` is one of our own two constants, never user input.
 */
async function findInLoginShell(
  name: string,
  deps: HelpEngineDeps,
): Promise<string | undefined> {
  const shell = deps.env.SHELL || '/bin/zsh';
  try {
    const result = await runChild(
      deps,
      shell,
      ['-lic', `command -v ${name}`],
      { env: deps.env },
      LOOKUP_TIMEOUT_MS,
      undefined,
      'the login shell',
    );
    if (result.code !== 0) {
      return undefined;
    }
    const lines = result.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    const last = lines[lines.length - 1];
    return last && path.isAbsolute(last) && isExecutableFile(last)
      ? last
      : undefined;
  } catch {
    return undefined;
  }
}

/** Everything §7.3 tried, for the `engine not found` message. */
export interface BinaryLookup {
  path?: string;
  tried: string[];
}

export async function resolveHelpBinary(
  name: 'claude' | 'codex',
  override: string | undefined,
  deps: HelpEngineDeps,
): Promise<BinaryLookup> {
  const tried: string[] = [];
  if (override && override.trim()) {
    const candidate = override.trim();
    tried.push(`readAloudHelpBinaryPath.${name} (${candidate})`);
    if (path.isAbsolute(candidate) && isExecutableFile(candidate)) {
      return { path: candidate, tried };
    }
  }
  const cached = binaryCache.get(name);
  if (cached && isExecutableFile(cached)) {
    return { path: cached, tried };
  }
  tried.push(`PATH (${deps.env.PATH || '(empty)'})`);
  const onPath = findOnPath(name, deps.env);
  if (onPath) {
    binaryCache.set(name, onPath);
    return { path: onPath, tried };
  }
  const shell = deps.env.SHELL || '/bin/zsh';
  tried.push(`${shell} -lic "command -v ${name}"`);
  const fromShell = await findInLoginShell(name, deps);
  if (fromShell) {
    binaryCache.set(name, fromShell);
    return { path: fromShell, tried };
  }
  return { tried };
}

// ----------------------------------------------------------------- the answer

/**
 * claude `--output-format json` prints one JSON object; `result` is the
 * answer and `is_error` the failure. Some builds print progress lines first,
 * so the last line that parses wins, with the whole of stdout as a fallback.
 */
/** The CLI's `usage` block, as far as the log wants it (13 §14.4). */
export interface ClaudeUsage {
  cacheRead?: number;
  cacheCreation?: number;
  costUsd?: number;
}

function usageOf(object: Record<string, unknown>): ClaudeUsage | undefined {
  const usage: ClaudeUsage = {};
  const raw = object.usage;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const fields = raw as Record<string, unknown>;
    if (typeof fields.cache_read_input_tokens === 'number') {
      usage.cacheRead = fields.cache_read_input_tokens;
    }
    if (typeof fields.cache_creation_input_tokens === 'number') {
      usage.cacheCreation = fields.cache_creation_input_tokens;
    }
  }
  if (typeof object.total_cost_usd === 'number') {
    usage.costUsd = object.total_cost_usd;
  }
  return Object.keys(usage).length ? usage : undefined;
}

export function parseClaudeJson(stdout: string): {
  answer: string;
  error?: string;
  usage?: ClaudeUsage;
} {
  const candidates: string[] = [];
  const trimmed = stdout.trim();
  if (trimmed) {
    const lines = trimmed.split('\n');
    // Backwards, so the *last* JSON line is tried first: the result object is
    // the last thing the CLI prints, and a progress line that also happens to
    // be JSON must never win over it.
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (line.startsWith('{') && line.endsWith('}')) {
        candidates.push(line);
      }
    }
    // Last resort: the whole of stdout, for a pretty-printed object.
    candidates.push(trimmed);
  }
  for (const candidate of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      continue;
    }
    const object = parsed as Record<string, unknown>;
    const result = typeof object.result === 'string' ? object.result : '';
    if (object.is_error === true) {
      return { answer: '', error: result || String(object.subtype ?? 'error') };
    }
    if (result) {
      const usage = usageOf(object);
      return usage ? { answer: result, usage } : { answer: result };
    }
  }
  return { answer: '', error: '' };
}

export interface HelpRunRequest {
  config: HelpEngineConfig;
  systemPrompt: string;
  userPrompt: string;
  codexPrompt: string;
  signal?: AbortSignal;
  /**
   * Classroom (13 §9.1): a working directory the caller owns. When present
   * the child spawns there and the directory is left in place, so every call
   * of a build shares one `cwd` and the CLI's prompt cache holds across them;
   * when absent the engine makes and removes its own, as help does.
   */
  cwd?: string;
}

export interface HelpRunResult {
  markdown: string;
  label: HelpEngineLabel;
  durationMs: number;
  /** claude only: the cache-read tokens the CLI reported (13 §14.4). */
  cacheRead?: number;
  /** claude only: the cache-creation tokens the CLI reported. */
  cacheCreation?: number;
  /** claude only: the CLI's `total_cost_usd`. */
  costUsd?: number;
}

/**
 * One help request, start to finish: resolve the binary, make an empty cwd,
 * spawn, feed the prompt, read the answer back, and clean the directory up
 * whatever happened.
 */
export async function runHelpEngine(
  request: HelpRunRequest,
  deps: HelpEngineDeps,
): Promise<HelpRunResult> {
  const { config } = request;
  const label = engineLabel(config);
  const started = Date.now();

  let binary: string;
  if (config.engine === 'custom') {
    binary = config.command[0] ?? '';
    if (!binary) {
      throw new HelpEngineError(
        'engine_not_found',
        'Set markdown-preview-enhanced.readAloudHelpCommand to the command that should answer.',
        false,
      );
    }
  } else {
    const lookup = await resolveHelpBinary(
      config.engine,
      config.binaryPath[config.engine],
      deps,
    );
    if (!lookup.path) {
      throw new HelpEngineError(
        'engine_not_found',
        `Could not find the ${config.engine} command. Tried: ${lookup.tried.join('; ')}. ` +
          `Set markdown-preview-enhanced.readAloudHelpBinaryPath.${config.engine} to its absolute path.`,
        false,
      );
    }
    binary = lookup.path;
  }

  const ownCwd = !request.cwd;
  let cwd: string;
  if (request.cwd) {
    cwd = request.cwd;
  } else {
    try {
      cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'mpe-help-'));
    } catch (error) {
      throw new HelpEngineError(
        'engine_failed',
        `Could not create a working directory: ${String(error)}`,
        true,
      );
    }
  }

  try {
    const invocation = buildInvocation(
      config,
      binary,
      request.systemPrompt,
      request.userPrompt,
      cwd,
      request.codexPrompt,
    );
    const env = { ...deps.env };
    const dir = path.dirname(binary);
    if (path.isAbsolute(binary) && dir) {
      env.PATH = `${dir}${path.delimiter}${env.PATH ?? ''}`;
    }
    const timeoutMs = clampHelpTimeout(config.timeoutSeconds) * 1000;
    const result = await runChild(
      deps,
      invocation.file,
      invocation.args,
      { cwd, env, stdin: invocation.stdin },
      timeoutMs,
      request.signal,
      `the ${label.engine} command`,
    );

    if (result.code !== 0) {
      const detail = excerpt(result.stderr || result.stdout);
      if (looksLikeAuthFailure(result.stderr || result.stdout)) {
        throw new HelpEngineError(
          'engine_auth',
          `${label.engine} is not signed in: ${detail || 'no detail'}`,
          false,
        );
      }
      throw new HelpEngineError(
        'engine_failed',
        `${label.engine} exited with code ${result.code}${detail ? `: ${detail}` : ''}`,
        true,
      );
    }

    let raw = '';
    let usage: ClaudeUsage | undefined;
    if (invocation.answerFrom === 'claudeJson') {
      const parsed = parseClaudeJson(result.stdout);
      usage = parsed.usage;
      if (parsed.error) {
        if (looksLikeAuthFailure(parsed.error)) {
          throw new HelpEngineError(
            'engine_auth',
            `claude is not signed in: ${excerpt(parsed.error)}`,
            false,
          );
        }
        throw new HelpEngineError(
          'engine_failed',
          `claude reported an error: ${excerpt(parsed.error)}`,
          true,
        );
      }
      raw = parsed.answer;
    } else if (invocation.answerFrom === 'file') {
      try {
        raw = fs.readFileSync(invocation.answerFile as string, 'utf8');
      } catch {
        raw = '';
      }
    } else {
      raw = result.stdout;
    }

    if (!raw.trim()) {
      throw new HelpEngineError(
        'engine_empty',
        `${label.engine} returned an empty answer.`,
        true,
      );
    }
    const out: HelpRunResult = {
      markdown: raw,
      label,
      durationMs: Date.now() - started,
    };
    if (usage) {
      if (usage.cacheRead !== undefined) {
        out.cacheRead = usage.cacheRead;
      }
      if (usage.cacheCreation !== undefined) {
        out.cacheCreation = usage.cacheCreation;
      }
      if (usage.costUsd !== undefined) {
        out.costUsd = usage.costUsd;
      }
    }
    return out;
  } finally {
    if (ownCwd) {
      try {
        fs.rmSync(cwd, { recursive: true, force: true });
      } catch {
        // The directory is under os.tmpdir(); leaving it is harmless.
      }
    }
  }
}

export function clampHelpTimeout(seconds: unknown): number {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) {
    return DEFAULT_HELP_TIMEOUT_SECONDS;
  }
  return Math.min(
    HELP_TIMEOUT_MAX_SECONDS,
    Math.max(HELP_TIMEOUT_MIN_SECONDS, Math.round(seconds)),
  );
}
