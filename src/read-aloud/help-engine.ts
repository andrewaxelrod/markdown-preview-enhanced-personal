import { spawn as nodeSpawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  COPILOT_CLAUDE_MODELS_FALLBACK,
  copilotModelFor,
  parseClaudeModelId,
  parseCopilotCatalog,
} from './copilot-models';

/**
 * The headless CLI that writes the explanation
 * (`featrues/04-help-module.md` §7).
 *
 * Node-only: `child_process` does not exist in the web bundle, so every path
 * here sits behind the controller's `isWebBuild` guard. No `vscode` import, so
 * the argv builder, the binary lookup and the run loop are unit-testable with
 * an injected `spawn`.
 *
 * Three rules the implementation must not lose:
 *
 * - **Never a shell for the engine.** The model, the effort and a custom argv
 *   go through as single argv elements, so nothing a setting contains can be
 *   word-split or expanded. The login-shell lookup of §7.3 is the one place a
 *   shell is used, and only with our own three constant binary names.
 * - **An empty `cwd`.** The child runs in a fresh directory under
 *   `os.tmpdir()`, so no project's `CLAUDE.md` or `AGENTS.md` is auto-loaded
 *   into the prompt and codex's read-only sandbox has nothing to read.
 * - **Copilot gets a throwaway home.** `copilot` keeps every session's prompt
 *   and answer in `session-store.db` and `session-state/` under
 *   `COPILOT_HOME`, and has no flag against it. The engine points
 *   `COPILOT_HOME` at a directory inside the run's own, removed with it, and
 *   seeds it with the user's `config.json` alone (the CLI's own wording is
 *   that a login it could not put in the credential store is kept there as
 *   plain text; the keychain, the gh CLI's login and a token in the
 *   environment are found without it). The user's `settings.json`,
 *   `mcp-config.json` and hooks are deliberately not copied.
 */

export const HELP_ENGINES = ['claude', 'codex', 'copilot', 'custom'] as const;
export type HelpEngineId = (typeof HELP_ENGINES)[number];
export const DEFAULT_HELP_ENGINE: HelpEngineId = 'claude';

/** The engines that are a binary to find (§7.3); `custom` names its own. */
export const CLI_ENGINES = ['claude', 'codex', 'copilot'] as const;
export type CliEngineId = (typeof CLI_ENGINES)[number];

export function isCliEngine(engine: HelpEngineId): engine is CliEngineId {
  return (CLI_ENGINES as readonly string[]).includes(engine);
}

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

/** Where copilot is told to write its usage statistics, inside the cwd. */
export const COPILOT_USAGE_FILE = 'copilot-usage.json';

/** The throwaway `COPILOT_HOME`, inside the cwd (see the module comment). */
export const COPILOT_HOME_DIR = 'copilot-home';

/**
 * `--available-tools=` with a name no tool has. Copilot CLI 1.0.83 keeps a
 * core set (`bash`, `view`, `edit`, `create`, `glob`, `grep`) visible
 * whatever the filter, so the argv also denies `shell` and `write` outright —
 * a denial beats every allow, and in `-p` mode a denied call is refused, not
 * prompted for — and takes the temp dir out of the readable paths, leaving
 * `view` the empty cwd. Measured: a prompt asking for a shell command, a
 * file and a read produced no tool event at all.
 */
export const COPILOT_NO_TOOLS = 'mpe_no_tools';

/**
 * VS Code's Copilot Chat extension puts a `copilot` *launcher* on the PATH
 * (`…/github.copilot-chat/copilotCli/copilot`) that is not the CLI: when the
 * CLI is missing it asks `Install GitHub Copilot CLI? [y/N]` on stdin and runs
 * `npm install -g` on a yes. It is never a candidate here.
 */
export const COPILOT_SHIM_RE = /github\.copilot-chat[\\/]copilotCli[\\/]/;

/** `copilot help config` is local and takes ~200 ms; this is a ceiling. */
export const COPILOT_CATALOG_TIMEOUT_MS = 15000;

/**
 * The catalog `copilot help config` prints is what the CLI *declares*, not
 * what the user's Copilot plan serves: on 2026-09-09 this plan listed
 * `claude-fable-5.1`, `claude-fable-5`, `claude-opus-5`, `claude-opus-4.8`
 * and `claude-sonnet-4.6` and refused every one at once, before any request,
 * with this line on stderr (`claude-sonnet-5` answered). The engine then
 * steps down to the next model of the same family, and gives up after
 * {@link COPILOT_MODEL_ATTEMPTS} refusals with a message that names them. A
 * refusal costs a CLI start (about two seconds), not a request.
 */
export const COPILOT_MODEL_UNAVAILABLE_RE =
  /from --model flag is not available/i;
export const COPILOT_MODEL_ATTEMPTS = 3;

/**
 * `claude-haiku-4.5` "does not support reasoning effort configuration": the
 * same prompt is sent once more without `--effort`, the model kept.
 */
export const COPILOT_EFFORT_UNSUPPORTED_RE =
  /does not support reasoning effort/i;

export interface HelpEngineConfig {
  engine: HelpEngineId;
  claudeModel: string;
  claudeEffort: ClaudeEffort;
  codexModel: string;
  codexEffort: CodexEffort;
  /** `custom` only: argv, prompt on stdin, answer on stdout. */
  command: string[];
  timeoutSeconds: number;
  binaryPath: Partial<Record<CliEngineId, string>>;
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
  if (config.engine === 'copilot') {
    // The Claude model and effort the `claude` engine has, by design: the
    // catalog id Copilot is actually given is resolved per run
    // (`copilot-models.ts`) and logged there.
    return {
      engine: 'copilot',
      model: config.claudeModel || DEFAULT_CLAUDE_MODEL,
      effort: config.claudeEffort,
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
  /** copilot: the file `--usage-output-file` names, read after a clean exit. */
  usageFile?: string;
  /** Variables set for the child on top of the host's (copilot: `COPILOT_HOME`). */
  env?: Record<string, string>;
  /** copilot: the catalog id that went after `--model`, and how it was chosen. */
  resolvedModel?: string;
  modelHow?: string;
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
 *
 * copilot (verified against Copilot CLI 1.0.83 on 2026-09-09): `-p` takes the
 * prompt as its own argument — piped stdin is ignored — so the same one
 * document codex gets goes there, as one argv element. `--silent` makes stdout
 * the answer alone, `--effort` takes the very names `claude --effort` does,
 * and `--model` gets the catalog id for the Claude model setting. No custom
 * instructions, no GitHub MCP server, no update check, no `ask_user`, and the
 * tool restrictions described at {@link COPILOT_NO_TOOLS}. The usage file is
 * how the cache column and the premium-request count reach the log.
 */
/** What the run loop can vary between copilot attempts (see runHelpEngine). */
export interface CopilotInvocationOptions {
  /** The ids `copilot help config` listed; the built-in list without. */
  catalog?: readonly string[];
  /** Send no `--effort`: the model refused the flag. */
  omitEffort?: boolean;
}

export function buildInvocation(
  config: HelpEngineConfig,
  binary: string,
  systemPrompt: string,
  userPrompt: string,
  cwd: string,
  codexPrompt: string,
  copilotOptions?: CopilotInvocationOptions,
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
  if (config.engine === 'copilot') {
    const choice = copilotModelFor(
      config.claudeModel || DEFAULT_CLAUDE_MODEL,
      copilotOptions?.catalog ?? COPILOT_CLAUDE_MODELS_FALLBACK,
    );
    const usageFile = path.join(cwd, COPILOT_USAGE_FILE);
    const args = ['-p', codexPrompt, '--model', choice.id];
    if (!copilotOptions?.omitEffort) {
      args.push('--effort', config.claudeEffort);
    }
    args.push(
      '--silent',
      '--no-color',
      '--no-auto-update',
      '--no-custom-instructions',
      '--disable-builtin-mcps',
      '--no-ask-user',
      `--available-tools=${COPILOT_NO_TOOLS}`,
      '--deny-tool=shell',
      '--deny-tool=write',
      '--disallow-temp-dir',
      '--usage-output-file',
      usageFile,
    );
    return {
      file: binary,
      args,
      stdin: '',
      answerFrom: 'stdout',
      usageFile,
      // eslint-disable-next-line @typescript-eslint/naming-convention -- an environment variable's name
      env: { COPILOT_HOME: copilotHomeFor(cwd) },
      resolvedModel: choice.id,
      modelHow: choice.how,
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
  'not authenticated',
  'please log in',
  'please run /login',
  'copilot login',
  'gh auth login',
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
      // copilot takes the prompt as an argument, and an argument has a
      // ceiling (about 1 MiB on macOS, 128 KiB on Linux); a retry will not
      // shrink it.
      const tooLong = error && error.code === 'E2BIG';
      fail(
        new HelpEngineError(
          notFound ? 'engine_not_found' : 'engine_failed',
          tooLong
            ? `${what}: the prompt is too long for one command-line argument (E2BIG).`
            : `${what}: ${error?.message ?? String(error)}`,
          !notFound && !tooLong,
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

/** `copilot help config`'s model list, per binary path (see readCopilotCatalog). */
const catalogCache = new Map<string, string[]>();

export function clearHelpBinaryCache(): void {
  binaryCache.clear();
  catalogCache.clear();
}

/** A candidate that must never be run as `name` (see {@link COPILOT_SHIM_RE}). */
function isLauncherShim(name: string, candidate: string): boolean {
  return name === 'copilot' && COPILOT_SHIM_RE.test(candidate);
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

/**
 * `command -v` without a shell: walk the PATH we were launched with. A
 * launcher shim is skipped, and reported through `refused`, so a real CLI
 * later on the PATH still wins.
 */
function findOnPath(
  name: string,
  env: NodeJS.ProcessEnv,
  refused: string[],
): string | undefined {
  const raw = env.PATH || env.Path || '';
  for (const dir of raw.split(path.delimiter)) {
    if (!dir) {
      continue;
    }
    const candidate = path.join(dir, name);
    if (isExecutableFile(candidate)) {
      if (isLauncherShim(name, candidate)) {
        if (!refused.includes(candidate)) {
          refused.push(candidate);
        }
        continue;
      }
      return candidate;
    }
  }
  return undefined;
}

/**
 * The login shell's own `which -a`. An extension host launched from the Dock
 * has the login shell's PATH only sometimes; on this machine `claude` lives in
 * `~/.local/bin` and `codex` under nvm's bin, neither of which is on a bare
 * PATH. `-a` lists every match, so a launcher shim ahead of the real CLI
 * does not hide it. `name` is one of our own three constants, never user
 * input.
 *
 * Rc files may print before the paths, so the answer is read from the end:
 * the trailing run of absolute paths, in PATH order.
 */
async function findInLoginShell(
  name: string,
  deps: HelpEngineDeps,
  refused: string[],
): Promise<string | undefined> {
  const shell = deps.env.SHELL || '/bin/zsh';
  try {
    const result = await runChild(
      deps,
      shell,
      ['-lic', `which -a ${name}`],
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
    const paths: string[] = [];
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!path.isAbsolute(lines[i])) {
        break;
      }
      paths.unshift(lines[i]);
    }
    for (const candidate of paths) {
      if (!isExecutableFile(candidate)) {
        continue;
      }
      if (isLauncherShim(name, candidate)) {
        if (!refused.includes(candidate)) {
          refused.push(candidate);
        }
        continue;
      }
      return candidate;
    }
    return undefined;
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
  name: CliEngineId,
  override: string | undefined,
  deps: HelpEngineDeps,
): Promise<BinaryLookup> {
  const tried: string[] = [];
  const refused: string[] = [];
  if (override && override.trim()) {
    const candidate = override.trim();
    tried.push(`readAloudHelpBinaryPath.${name} (${candidate})`);
    if (
      path.isAbsolute(candidate) &&
      isExecutableFile(candidate) &&
      !isLauncherShim(name, candidate)
    ) {
      return { path: candidate, tried };
    }
    if (isLauncherShim(name, candidate)) {
      refused.push(candidate);
    }
  }
  const cached = binaryCache.get(name);
  if (cached && isExecutableFile(cached)) {
    return { path: cached, tried };
  }
  tried.push(`PATH (${deps.env.PATH || '(empty)'})`);
  const onPath = findOnPath(name, deps.env, refused);
  if (onPath) {
    binaryCache.set(name, onPath);
    return { path: onPath, tried };
  }
  const shell = deps.env.SHELL || '/bin/zsh';
  tried.push(`${shell} -lic "which -a ${name}"`);
  const fromShell = await findInLoginShell(name, deps, refused);
  if (fromShell) {
    binaryCache.set(name, fromShell);
    return { path: fromShell, tried };
  }
  if (refused.length) {
    tried.push(
      `skipped VS Code's Copilot Chat launcher at ${refused.join(', ')}, which is not the CLI`,
    );
  }
  return { tried };
}

/**
 * The lookup of several CLI engines at once, for the _Choose Help Engine_
 * quick pick and for the not-found message, which names the CLIs that *are*
 * installed. A Mac that has one of them and not the others is the expected
 * case, not an error.
 */
export async function detectHelpBinaries(
  binaryPath: Partial<Record<CliEngineId, string>>,
  deps: HelpEngineDeps,
  names: readonly CliEngineId[] = CLI_ENGINES,
): Promise<Partial<Record<CliEngineId, BinaryLookup>>> {
  const entries = await Promise.all(
    names.map(
      async (name) =>
        [name, await resolveHelpBinary(name, binaryPath[name], deps)] as const,
    ),
  );
  return Object.fromEntries(entries);
}

// ------------------------------------------------------------------ copilot

/** The throwaway `COPILOT_HOME` of a run (see the module comment). */
export function copilotHomeFor(cwd: string): string {
  return path.join(cwd, COPILOT_HOME_DIR);
}

/**
 * Make the throwaway home and seed it with the user's `config.json` when
 * there is one, so a login the CLI kept as plain text is still seen. Nothing
 * else is copied. Idempotent, so a build that reuses its cwd seeds once.
 */
export function seedCopilotHome(
  home: string,
  hostEnv: NodeJS.ProcessEnv,
): void {
  try {
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    const target = path.join(home, 'config.json');
    if (fs.existsSync(target)) {
      return;
    }
    const realHome =
      hostEnv.COPILOT_HOME && hostEnv.COPILOT_HOME.trim()
        ? hostEnv.COPILOT_HOME.trim()
        : path.join(os.homedir(), '.copilot');
    const source = path.join(realHome, 'config.json');
    if (fs.existsSync(source)) {
      fs.copyFileSync(source, target);
    }
  } catch {
    // The CLI makes its own home when it must; a missing seed costs at most
    // a plain-text login, which the error path will name.
  }
}

/**
 * The model ids the installed CLI lists under `model` in `copilot help
 * config` — local, no sign-in, about 200 ms — cached per binary path for the
 * life of the extension host. Undefined when the text cannot be read or has
 * no Claude model in it, and the built-in list stands in.
 */
export async function readCopilotCatalog(
  binary: string,
  deps: HelpEngineDeps,
  env: NodeJS.ProcessEnv,
): Promise<string[] | undefined> {
  const cached = catalogCache.get(binary);
  if (cached) {
    return cached;
  }
  try {
    const result = await runChild(
      deps,
      binary,
      ['help', 'config'],
      { env },
      COPILOT_CATALOG_TIMEOUT_MS,
      undefined,
      'copilot help config',
    );
    if (result.code !== 0) {
      return undefined;
    }
    const ids = parseCopilotCatalog(result.stdout);
    if (!ids.some((id) => id.startsWith('claude-'))) {
      return undefined;
    }
    catalogCache.set(binary, ids);
    return ids;
  } catch {
    return undefined;
  }
}

/**
 * copilot's `--usage-output-file`: `tokenDetails.cache_read` /
 * `cache_write` are the cache column, `totalPremiumRequestCost` the
 * premium requests the run cost the subscription.
 */
export function parseCopilotUsage(text: string): EngineUsage | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return undefined;
  }
  const object = parsed as Record<string, unknown>;
  const usage: EngineUsage = {};
  const details = object.tokenDetails;
  if (details && typeof details === 'object' && !Array.isArray(details)) {
    const count = (key: string): number | undefined => {
      const entry = (details as Record<string, unknown>)[key];
      if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
        const value = (entry as Record<string, unknown>).tokenCount;
        return typeof value === 'number' ? value : undefined;
      }
      return undefined;
    };
    const read = count('cache_read');
    if (read !== undefined) {
      usage.cacheRead = read;
    }
    const write = count('cache_write');
    if (write !== undefined) {
      usage.cacheCreation = write;
    }
  }
  if (typeof object.totalPremiumRequestCost === 'number') {
    usage.premiumRequests = object.totalPremiumRequestCost;
  }
  return Object.keys(usage).length ? usage : undefined;
}

// ----------------------------------------------------------------- the answer

/**
 * claude `--output-format json` prints one JSON object; `result` is the
 * answer and `is_error` the failure. Some builds print progress lines first,
 * so the last line that parses wins, with the whole of stdout as a fallback.
 */
/**
 * What an engine reports about a run, as far as the log wants it (13 §14.4):
 * claude's `usage` block and `total_cost_usd`, copilot's usage file.
 */
export interface EngineUsage {
  cacheRead?: number;
  cacheCreation?: number;
  /** claude: `total_cost_usd`. */
  costUsd?: number;
  /** copilot: `totalPremiumRequestCost`. */
  premiumRequests?: number;
}

/** The old name; claude's `usage` block was the first shape. */
export type ClaudeUsage = EngineUsage;

function usageOf(object: Record<string, unknown>): EngineUsage | undefined {
  const usage: EngineUsage = {};
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
  usage?: EngineUsage;
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
  /** claude and copilot: the cache-read tokens the CLI reported (13 §14.4). */
  cacheRead?: number;
  /** claude and copilot: the cache-creation tokens the CLI reported. */
  cacheCreation?: number;
  /** claude only: the CLI's `total_cost_usd`. */
  costUsd?: number;
  /** copilot only: the premium requests the run cost. */
  premiumRequests?: number;
  /** copilot only: the catalog id the CLI was given for the Claude model setting. */
  model?: string;
}

const INSTALL_HINTS: Record<CliEngineId, string> = {
  claude:
    'Install it with `curl -fsSL https://claude.ai/install.sh | bash` and sign in once.',
  codex: 'Install it with `npm install -g @openai/codex` and sign in once.',
  copilot:
    "Install it with `npm install -g @github/copilot` (or `curl -fsSL https://gh.io/copilot-install | bash`); it signs in with `copilot login`, the gh CLI's login, or a token in GH_TOKEN.",
};

/** What the sheet says once every model tried was refused by the plan. */
function modelUnavailableMessage(refused: string[]): string {
  const list = refused.join(', ');
  return (
    `copilot: ${list} ${refused.length === 1 ? 'is' : 'are'} not available on this Copilot plan. ` +
    'Choose another model with "Markdown Preview Enhanced: Choose Help Model" (sonnet is the default).'
  );
}

/**
 * §7.3 — what the sheet says when the configured CLI is not on this machine.
 * It names what was tried and, because a computer often has one CLI and not
 * the others, whichever *other* CLI engines are installed and the command
 * that switches to one.
 */
async function notFoundMessage(
  engine: CliEngineId,
  config: HelpEngineConfig,
  lookup: BinaryLookup,
  deps: HelpEngineDeps,
): Promise<string> {
  const names = CLI_ENGINES.filter((name) => name !== engine);
  const found = await detectHelpBinaries(config.binaryPath, deps, names);
  const others = names.filter((name) => found[name]?.path);
  const nudge = others.length
    ? ` Installed here: ${others.map((name) => `${name} (${found[name]?.path})`).join(', ')} — run "Markdown Preview Enhanced: Choose Help Engine" to switch.`
    : '';
  return (
    `Could not find the ${engine} command. Tried: ${lookup.tried.join('; ')}. ` +
    `${INSTALL_HINTS[engine]} If it is installed, set markdown-preview-enhanced.readAloudHelpBinaryPath.${engine} to its absolute path.` +
    nudge
  );
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
        await notFoundMessage(config.engine, config, lookup, deps),
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
    const env = { ...deps.env };
    const dir = path.dirname(binary);
    if (path.isAbsolute(binary) && dir) {
      env.PATH = `${dir}${path.delimiter}${env.PATH ?? ''}`;
    }
    let catalog: readonly string[] | undefined;
    if (config.engine === 'copilot') {
      const home = copilotHomeFor(cwd);
      seedCopilotHome(home, deps.env);
      catalog = await readCopilotCatalog(binary, deps, {
        ...env,
        // eslint-disable-next-line @typescript-eslint/naming-convention -- an environment variable's name
        COPILOT_HOME: home,
      });
      if (!catalog) {
        deps.log(
          'copilot: could not read the model list from `copilot help config`; using the built-in list',
        );
      }
    }
    const timeoutMs = clampHelpTimeout(config.timeoutSeconds) * 1000;
    // copilot may refuse the model its own catalog lists, or the --effort
    // flag for a model that takes none (the two regexes above). A refused
    // model comes out of the catalog and the mapping is asked again, which is
    // the next model of the family; a refused flag is dropped once. Every
    // other engine goes round exactly once.
    let catalogNow: readonly string[] | undefined = catalog;
    let omitEffort = false;
    const refusedModels: string[] = [];
    let invocation: HelpInvocation;
    let result: RunResult;
    for (;;) {
      invocation = buildInvocation(
        config,
        binary,
        request.systemPrompt,
        request.userPrompt,
        cwd,
        request.codexPrompt,
        { catalog: catalogNow, omitEffort },
      );
      const model = invocation.resolvedModel;
      // Nothing left in the family: the mapping has fallen back to passing
      // the setting through, which is a guess, not a catalog model.
      const exhausted =
        model !== undefined &&
        (refusedModels.includes(model) ||
          (invocation.modelHow === 'passthrough' && refusedModels.length > 0));
      if (exhausted) {
        throw new HelpEngineError(
          'engine_failed',
          modelUnavailableMessage(refusedModels),
          false,
        );
      }
      Object.assign(env, invocation.env);
      if (model !== undefined) {
        deps.log(
          `copilot: model ${label.model} → ${model} (${invocation.modelHow}${omitEffort ? ', no effort' : ''})`,
        );
      }
      result = await runChild(
        deps,
        invocation.file,
        invocation.args,
        { cwd, env, stdin: invocation.stdin },
        timeoutMs,
        request.signal,
        `the ${label.engine} command`,
      );
      if (model === undefined || result.code === 0) {
        break;
      }
      const said = result.stderr + result.stdout;
      if (!omitEffort && COPILOT_EFFORT_UNSUPPORTED_RE.test(said)) {
        omitEffort = true;
        deps.log(
          `copilot: ${model} takes no --effort; sending the prompt again without one`,
        );
        continue;
      }
      if (!COPILOT_MODEL_UNAVAILABLE_RE.test(said)) {
        break;
      }
      refusedModels.push(model);
      if (refusedModels.length >= COPILOT_MODEL_ATTEMPTS) {
        throw new HelpEngineError(
          'engine_failed',
          modelUnavailableMessage(refusedModels),
          false,
        );
      }
      const family = parseClaudeModelId(model)?.family ?? 'Claude';
      deps.log(
        `copilot: ${model} is not available on this Copilot plan; trying the next ${family} model`,
      );
      catalogNow = (catalogNow ?? COPILOT_CLAUDE_MODELS_FALLBACK).filter(
        (id) => !refusedModels.includes(id),
      );
    }

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
    let usage: EngineUsage | undefined;
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
    if (invocation.usageFile) {
      try {
        usage = parseCopilotUsage(
          fs.readFileSync(invocation.usageFile, 'utf8'),
        );
      } catch {
        // No usage file is a log line short, not a failed answer.
      }
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
    if (invocation.resolvedModel) {
      out.model = invocation.resolvedModel;
    }
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
      if (usage.premiumRequests !== undefined) {
        out.premiumRequests = usage.premiumRequests;
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
