/* global suite, test, suiteSetup, suiteTeardown, setup */

/**
 * `src/read-aloud/help-engine.ts` and `src/read-aloud/help-answer.ts`
 * (`featrues/04-help-module.md` §6, §7).
 *
 * `runHelpEngine` takes its `spawn` from `deps`, which is the whole point of
 * the injection: the argv, the lookup, the kill path and every error code can
 * be driven from here without a CLI on the machine.
 *
 * The two invariants worth breaking a build over:
 *
 * - **no shell.** The model, the effort and a custom argv are single argv
 *   elements, so a setting cannot be word-split or expanded.
 * - **no raw HTML from an answer.** `sanitizeHelpAnswer` escapes every `<`
 *   before `parseMD` sees it; the prompt forbidding HTML is not the guarantee.
 */

const assert = require('node:assert');
const os = require('node:os');
const path = require('path');
const fs = require('fs');
const { EventEmitter } = require('node:events');
const esbuild = require('esbuild');

let engine;
let answer;
let engineBundle;
let answerBundle;
let binDir;
let fakeBinary;

async function compile(name, outFile) {
  const result = await esbuild.build({
    entryPoints: [
      path.join(__dirname, '..', '..', 'src', 'read-aloud', `${name}.ts`),
    ],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    write: false,
    logLevel: 'silent',
    external: ['vscode', 'crossnote'],
  });
  fs.writeFileSync(outFile, result.outputFiles[0].text);
  return require(outFile);
}

// ------------------------------------------------------------- the fake spawn

/**
 * A `spawn` with the slice of the child-process surface `runChild` touches:
 * `stdout`/`stderr` as emitters, a `stdin` sink that records what was written,
 * `on('error' | 'close')`, and a `kill` that records its signals.
 *
 * `handler(call)` drives one child, on the next tick so that `runChild` has
 * finished attaching its listeners.
 */
function makeSpawn(handler) {
  const calls = [];
  function spawn(file, args, options) {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    const written = [];
    let ended = false;
    child.stdin = {
      write(chunk) {
        written.push(String(chunk));
        return true;
      },
      end() {
        ended = true;
      },
      on() {},
    };
    child.signals = [];
    child.kill = function (signal) {
      child.signals.push(signal);
      return true;
    };
    const call = {
      file,
      args,
      options,
      child,
      signals: child.signals,
      get stdin() {
        return written.join('');
      },
      get stdinEnded() {
        return ended;
      },
      /** Emit both streams and exit. */
      finish(result) {
        if (result.stdout) {
          child.stdout.emit('data', Buffer.from(result.stdout));
        }
        if (result.stderr) {
          child.stderr.emit('data', Buffer.from(result.stderr));
        }
        child.emit('close', result.code === undefined ? 0 : result.code);
      },
    };
    calls.push(call);
    setImmediate(function () {
      handler(call);
    });
    return child;
  }
  spawn.calls = calls;
  return spawn;
}

/** A spawn that never lets its children exit; for the kill paths. */
function makeHangingSpawn(onSpawn) {
  return makeSpawn(function (call) {
    if (onSpawn) {
      onSpawn(call);
    }
  });
}

/**
 * The timeout is 15 s at its floor, which no unit test may wait for. Timers
 * longer than 50 ms are compressed while `fn` runs; `KILL_GRACE_MS` rides
 * along, which is harmless because `cleanup()` clears it on the way out.
 */
async function withCompressedTimers(fn) {
  const realSetTimeout = global.setTimeout;
  global.setTimeout = function (callback, ms) {
    const rest = Array.prototype.slice.call(arguments, 2);
    const scaled = typeof ms === 'number' && ms > 50 ? 5 : ms;
    return realSetTimeout.apply(null, [callback, scaled].concat(rest));
  };
  try {
    return await fn();
  } finally {
    global.setTimeout = realSetTimeout;
  }
}

// ------------------------------------------------------------------- fixtures

function config(overrides) {
  return Object.assign(
    {
      engine: 'claude',
      claudeModel: 'sonnet',
      claudeEffort: 'low',
      codexModel: '',
      codexEffort: 'low',
      command: [],
      timeoutSeconds: 90,
      binaryPath: {},
    },
    overrides,
  );
}

function deps(spawn, env) {
  return {
    spawn,
    log: function () {},
    env: env === undefined ? { PATH: '/usr/bin', SHELL: '/bin/zsh' } : env,
  };
}

function request(overrides) {
  return Object.assign(
    {
      config: config(),
      systemPrompt: 'SYSTEM',
      userPrompt: 'USER',
      codexPrompt: '<instructions>\nSYSTEM\n</instructions>\n\nUSER',
    },
    overrides,
  );
}

async function rejection(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new assert.AssertionError({ message: 'expected a rejection' });
}

suite('read-aloud/help-engine', function () {
  this.timeout(20000);

  suiteSetup(async function () {
    engineBundle = path.join(__dirname, '.help-engine.bundle.cjs');
    engine = await compile('help-engine', engineBundle);

    // An absolute, executable file so `resolveHelpBinary` accepts the override
    // and never touches the PATH or the login shell.
    binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpe-help-bin-'));
    fakeBinary = path.join(binDir, 'fake-cli');
    fs.writeFileSync(fakeBinary, '#!/bin/sh\nexit 0\n', 'utf8');
    fs.chmodSync(fakeBinary, 0o755);
  });

  suiteTeardown(function () {
    if (engineBundle && fs.existsSync(engineBundle)) {
      fs.unlinkSync(engineBundle);
    }
    if (binDir && fs.existsSync(binDir)) {
      fs.rmSync(binDir, { recursive: true, force: true });
    }
  });

  setup(function () {
    engine.clearHelpBinaryCache();
  });

  // ------------------------------------------------------------------- §7.2

  suite('§7.2 buildInvocation — claude', function () {
    function claudeArgs(overrides) {
      return engine.buildInvocation(
        config(Object.assign({ engine: 'claude' }, overrides)),
        '/bin/claude',
        'SYSTEM',
        'USER',
        '/tmp/cwd',
        'CODEX',
      );
    }

    test('is the exact argv of §7.2', function () {
      const invocation = claudeArgs();
      assert.strictEqual(invocation.file, '/bin/claude');
      assert.deepStrictEqual(invocation.args, [
        '-p',
        '--output-format',
        'json',
        '--tools',
        '',
        '--no-session-persistence',
        '--disable-slash-commands',
        '--model',
        'sonnet',
        '--effort',
        'low',
        '--system-prompt',
        'SYSTEM',
      ]);
      assert.strictEqual(invocation.stdin, 'USER');
      assert.strictEqual(invocation.answerFrom, 'claudeJson');
      assert.strictEqual(invocation.answerFile, undefined);
    });

    test('never passes --bare: it would restrict auth to ANTHROPIC_API_KEY', function () {
      assert.ok(!claudeArgs().args.includes('--bare'));
      assert.ok(
        !claudeArgs({ claudeModel: '', claudeEffort: 'max' }).args.includes(
          '--bare',
        ),
      );
    });

    test('an empty model falls back to the default alias', function () {
      const args = claudeArgs({ claudeModel: '' }).args;
      assert.strictEqual(
        args[args.indexOf('--model') + 1],
        engine.DEFAULT_CLAUDE_MODEL,
      );
      assert.strictEqual(engine.DEFAULT_CLAUDE_MODEL, 'sonnet');
    });

    test('every effort level rides through as one argv element', function () {
      for (const effort of engine.CLAUDE_EFFORTS) {
        const args = claudeArgs({ claudeEffort: effort }).args;
        assert.strictEqual(args[args.indexOf('--effort') + 1], effort);
      }
    });

    test('a model with a space stays one argv element, never a shell string', function () {
      const hostile = 'claude-3 fake"; rm -rf / #';
      const args = claudeArgs({ claudeModel: hostile }).args;
      assert.strictEqual(args[args.indexOf('--model') + 1], hostile);
      assert.strictEqual(
        args.filter(function (arg) {
          return arg === hostile;
        }).length,
        1,
      );
      for (const arg of args) {
        assert.ok(
          !/--model\s/.test(arg),
          `argv element must not carry a flag and its value: ${arg}`,
        );
      }
    });

    test('the whole system prompt is one argv element', function () {
      const system = 'line one\nline two "quoted" $(echo hi)';
      const args = claudeArgs().args;
      assert.strictEqual(args[args.length - 2], '--system-prompt');
      const invocation = engine.buildInvocation(
        config({ engine: 'claude' }),
        '/bin/claude',
        system,
        'USER',
        '/tmp/cwd',
        'CODEX',
      );
      assert.strictEqual(invocation.args[invocation.args.length - 1], system);
    });
  });

  suite('§7.2 buildInvocation — codex', function () {
    function codexArgs(overrides) {
      return engine.buildInvocation(
        config(Object.assign({ engine: 'codex' }, overrides)),
        '/bin/codex',
        'SYSTEM',
        'USER',
        '/tmp/cwd',
        'CODEX',
      );
    }

    test('reads the prompt from stdin and writes the answer to a file', function () {
      const invocation = codexArgs();
      assert.strictEqual(invocation.file, '/bin/codex');
      assert.deepStrictEqual(invocation.args, [
        'exec',
        '-',
        '--ephemeral',
        '--skip-git-repo-check',
        '-s',
        'read-only',
        '-C',
        '/tmp/cwd',
        '--color',
        'never',
        '-c',
        'model_reasoning_effort=low',
        '-o',
        path.join('/tmp/cwd', engine.CODEX_ANSWER_FILE),
      ]);
      assert.strictEqual(invocation.stdin, 'CODEX');
      assert.strictEqual(invocation.answerFrom, 'file');
      assert.strictEqual(
        invocation.answerFile,
        path.join('/tmp/cwd', 'answer.md'),
      );
    });

    test('the sandbox is read-only and the cwd is the empty directory', function () {
      const args = codexArgs().args;
      assert.strictEqual(args[args.indexOf('-s') + 1], 'read-only');
      assert.strictEqual(args[args.indexOf('-C') + 1], '/tmp/cwd');
      assert.strictEqual(args[args.indexOf('--color') + 1], 'never');
      assert.ok(args.includes('--ephemeral'));
      assert.ok(args.includes('--skip-git-repo-check'));
    });

    test('an empty codexModel omits -m entirely', function () {
      const args = codexArgs({ codexModel: '' }).args;
      assert.ok(!args.includes('-m'), args.join(' '));
      assert.ok(!args.includes('--model'), args.join(' '));
    });

    test('a codexModel is passed as -m plus one argv element', function () {
      const args = codexArgs({ codexModel: 'gpt-5 codex' }).args;
      assert.strictEqual(args[args.indexOf('-m') + 1], 'gpt-5 codex');
    });

    test('effort `default` omits the -c override', function () {
      const args = codexArgs({ codexEffort: 'default' }).args;
      assert.ok(!args.includes('-c'), args.join(' '));
      assert.ok(
        !args.some(function (arg) {
          return arg.indexOf('model_reasoning_effort') === 0;
        }),
      );
    });

    test('every other effort is one -c override, as a single argv element', function () {
      for (const effort of engine.CODEX_EFFORTS) {
        const args = codexArgs({ codexEffort: effort }).args;
        if (effort === 'default') {
          continue;
        }
        assert.strictEqual(
          args[args.indexOf('-c') + 1],
          `model_reasoning_effort=${effort}`,
          effort,
        );
      }
    });

    test('-o is always last, so the answer file is unambiguous', function () {
      for (const overrides of [
        {},
        { codexModel: 'gpt-5' },
        { codexEffort: 'default' },
        { codexModel: 'gpt-5', codexEffort: 'default' },
      ]) {
        const args = codexArgs(overrides).args;
        assert.strictEqual(args[args.length - 2], '-o');
        assert.strictEqual(
          args[args.length - 1],
          path.join('/tmp/cwd', 'answer.md'),
        );
      }
    });
  });

  suite('§7.2 buildInvocation — copilot', function () {
    const CATALOG = [
      'claude-sonnet-5',
      'claude-fable-5.1',
      'claude-opus-5',
      'claude-sonnet-4.6',
      'gpt-5.5',
    ];
    /** `catalog: null` passes no catalog at all, so the built-in list answers. */
    function copilotArgs(overrides, catalog) {
      return engine.buildInvocation(
        config(Object.assign({ engine: 'copilot' }, overrides)),
        '/bin/copilot',
        'SYSTEM',
        'USER',
        '/tmp/cwd',
        'CODEX',
        catalog === null
          ? undefined
          : { catalog: catalog === undefined ? CATALOG : catalog },
      );
    }

    test('is the exact argv: the one document as -p, the catalog model, the claude effort, no tools', function () {
      const invocation = copilotArgs();
      assert.strictEqual(invocation.file, '/bin/copilot');
      assert.deepStrictEqual(invocation.args, [
        '-p',
        'CODEX',
        '--model',
        'claude-sonnet-5',
        '--effort',
        'low',
        '--silent',
        '--no-color',
        '--no-auto-update',
        '--no-custom-instructions',
        '--disable-builtin-mcps',
        '--no-ask-user',
        '--available-tools=mpe_no_tools',
        '--deny-tool=shell',
        '--deny-tool=write',
        '--disallow-temp-dir',
        '--usage-output-file',
        path.join('/tmp/cwd', 'copilot-usage.json'),
      ]);
      // Nothing on stdin: the CLI ignores it and takes the prompt from -p.
      assert.strictEqual(invocation.stdin, '');
      assert.strictEqual(invocation.answerFrom, 'stdout');
      assert.strictEqual(
        invocation.usageFile,
        path.join('/tmp/cwd', 'copilot-usage.json'),
      );
      assert.deepStrictEqual(invocation.env, {
        COPILOT_HOME: path.join('/tmp/cwd', 'copilot-home'),
      });
      assert.strictEqual(invocation.resolvedModel, 'claude-sonnet-5');
      assert.strictEqual(invocation.modelHow, 'alias');
    });

    test('the whole prompt is one argv element, never split or quoted', function () {
      const prompt =
        '<instructions>\nline "one" and $HOME\n</instructions>\n\nwhat is \'this\'?';
      const invocation = engine.buildInvocation(
        config({ engine: 'copilot' }),
        '/bin/copilot',
        'SYSTEM',
        'USER',
        '/tmp/cwd',
        prompt,
        { catalog: CATALOG },
      );
      assert.strictEqual(invocation.args[0], '-p');
      assert.strictEqual(invocation.args[1], prompt);
      assert.strictEqual(invocation.args.length, copilotArgs().args.length);
    });

    test('the claude model and effort settings drive it; the codex ones are ignored', function () {
      const fable = copilotArgs({
        claudeModel: 'fable',
        claudeEffort: 'max',
        codexModel: 'gpt-5.5',
        codexEffort: 'high',
      });
      assert.strictEqual(
        fable.args[fable.args.indexOf('--model') + 1],
        'claude-fable-5.1',
      );
      assert.strictEqual(fable.args[fable.args.indexOf('--effort') + 1], 'max');
      assert.ok(!fable.args.includes('gpt-5.5') && !fable.args.includes('-m'));
      assert.ok(!fable.args.includes('high'));

      const pinned = copilotArgs({ claudeModel: 'claude-fable-5-1' });
      assert.strictEqual(pinned.resolvedModel, 'claude-fable-5.1');
      assert.strictEqual(pinned.modelHow, 'exact');

      const stale = copilotArgs({ claudeModel: 'claude-sonnet-4-5-20250929' });
      assert.strictEqual(stale.resolvedModel, 'claude-sonnet-5');
      assert.strictEqual(stale.modelHow, 'family');
    });

    test('omitEffort drops the flag and nothing else', function () {
      const without = engine.buildInvocation(
        config({ engine: 'copilot' }),
        '/bin/copilot',
        'SYSTEM',
        'USER',
        '/tmp/cwd',
        'CODEX',
        { catalog: CATALOG, omitEffort: true },
      );
      const withEffort = copilotArgs();
      assert.ok(!without.args.includes('--effort'));
      assert.ok(!without.args.includes('low'));
      assert.deepStrictEqual(
        without.args,
        withEffort.args.filter((arg) => arg !== '--effort' && arg !== 'low'),
      );
    });

    test('every claude effort level rides through as one argv element', function () {
      for (const effort of engine.CLAUDE_EFFORTS) {
        const invocation = copilotArgs({ claudeEffort: effort });
        assert.strictEqual(
          invocation.args[invocation.args.indexOf('--effort') + 1],
          effort,
        );
      }
    });

    test('without a catalog the built-in list answers, and an empty model is the default alias', function () {
      const opus = copilotArgs({ claudeModel: 'opus' }, null);
      assert.strictEqual(opus.resolvedModel, 'claude-opus-5');
      assert.strictEqual(opus.modelHow, 'alias');
      const empty = copilotArgs({ claudeModel: '' }, null);
      assert.strictEqual(empty.resolvedModel, 'claude-sonnet-5');
    });
  });

  suite('§7.2 buildInvocation — custom', function () {
    test('the argv is the setting, verbatim', function () {
      const command = ['/usr/local/bin/my llm', '--flag', 'a b c', ''];
      const invocation = engine.buildInvocation(
        config({ engine: 'custom', command }),
        'ignored',
        'SYSTEM',
        'USER',
        '/tmp/cwd',
        'CODEX',
      );
      assert.strictEqual(invocation.file, '/usr/local/bin/my llm');
      assert.deepStrictEqual(invocation.args, ['--flag', 'a b c', '']);
      assert.strictEqual(invocation.stdin, 'CODEX');
      assert.strictEqual(invocation.answerFrom, 'stdout');
      assert.strictEqual(invocation.answerFile, undefined);
    });

    test('no model and no effort flag is added', function () {
      const invocation = engine.buildInvocation(
        config({
          engine: 'custom',
          command: ['llm'],
          claudeModel: 'opus',
          codexModel: 'gpt-5',
          codexEffort: 'high',
        }),
        'ignored',
        'SYSTEM',
        'USER',
        '/tmp/cwd',
        'CODEX',
      );
      assert.deepStrictEqual(invocation.args, []);
      for (const flag of ['-m', '--model', '-c', '--effort']) {
        assert.ok(!invocation.args.includes(flag), flag);
      }
    });

    test('an empty command gives an empty file, which runHelpEngine rejects', function () {
      const invocation = engine.buildInvocation(
        config({ engine: 'custom', command: [] }),
        'ignored',
        'SYSTEM',
        'USER',
        '/tmp/cwd',
        'CODEX',
      );
      assert.strictEqual(invocation.file, '');
      assert.deepStrictEqual(invocation.args, []);
    });
  });

  // ------------------------------------------------------------ parseClaudeJson

  suite('parseClaudeJson', function () {
    test('a plain result object is the answer', function () {
      assert.deepStrictEqual(
        engine.parseClaudeJson('{"result":"### What it says\\nHello"}'),
        { answer: '### What it says\nHello' },
      );
    });

    test('surrounding whitespace and a trailing newline are fine', function () {
      assert.deepStrictEqual(
        engine.parseClaudeJson('\n  {"result":"Hi","is_error":false}  \n'),
        { answer: 'Hi' },
      );
    });

    test('is_error true returns the error, never an answer', function () {
      assert.deepStrictEqual(
        engine.parseClaudeJson('{"result":"boom","is_error":true}'),
        { answer: '', error: 'boom' },
      );
      assert.deepStrictEqual(
        engine.parseClaudeJson('{"is_error":true,"subtype":"error_max_turns"}'),
        { answer: '', error: 'error_max_turns' },
      );
      assert.deepStrictEqual(engine.parseClaudeJson('{"is_error":true}'), {
        answer: '',
        error: 'error',
      });
    });

    test('progress lines before the JSON do not hide the answer', function () {
      const stdout =
        'Loading model...\nstill thinking\n{"result":"Hello","is_error":false}\n';
      assert.deepStrictEqual(engine.parseClaudeJson(stdout), {
        answer: 'Hello',
      });
    });

    test('a JSON progress line never beats the result object after it', function () {
      // The result is the last thing the CLI prints, so the scan runs
      // backwards: an earlier line that also happens to be JSON must lose.
      const stdout =
        '{"type":"system","subtype":"init"}\n' +
        '{"result":"The real answer","is_error":false}\n';
      assert.deepStrictEqual(engine.parseClaudeJson(stdout), {
        answer: 'The real answer',
      });
    });

    test('unparseable stdout is empty, not a throw', function () {
      for (const stdout of [
        '',
        '   ',
        'not json at all',
        '{broken',
        '[1,2,3]',
        '"a string"',
        '{"result":42}',
      ]) {
        assert.deepStrictEqual(
          engine.parseClaudeJson(stdout),
          { answer: '', error: '' },
          JSON.stringify(stdout),
        );
      }
    });
  });

  // ---------------------------------------------------------- clamp and label

  suite('clampHelpTimeout', function () {
    test('clamps to the 15–300 s range', function () {
      assert.strictEqual(engine.clampHelpTimeout(0), 15);
      assert.strictEqual(engine.clampHelpTimeout(-100), 15);
      assert.strictEqual(engine.clampHelpTimeout(14), 15);
      assert.strictEqual(engine.clampHelpTimeout(15), 15);
      assert.strictEqual(engine.clampHelpTimeout(120), 120);
      assert.strictEqual(engine.clampHelpTimeout(300), 300);
      assert.strictEqual(engine.clampHelpTimeout(301), 300);
      assert.strictEqual(engine.clampHelpTimeout(100000), 300);
    });

    test('rounds a fractional value', function () {
      assert.strictEqual(engine.clampHelpTimeout(90.4), 90);
      assert.strictEqual(engine.clampHelpTimeout(90.6), 91);
    });

    test('anything that is not a finite number is the 90 s default', function () {
      for (const value of [
        undefined,
        null,
        '90',
        {},
        [],
        Number.NaN,
        Number.POSITIVE_INFINITY,
        Number.NEGATIVE_INFINITY,
      ]) {
        assert.strictEqual(
          engine.clampHelpTimeout(value),
          engine.DEFAULT_HELP_TIMEOUT_SECONDS,
          String(value),
        );
      }
      assert.strictEqual(engine.DEFAULT_HELP_TIMEOUT_SECONDS, 90);
    });
  });

  suite('engineLabel', function () {
    test('claude names its model and effort', function () {
      assert.deepStrictEqual(
        engine.engineLabel(
          config({
            engine: 'claude',
            claudeModel: 'opus',
            claudeEffort: 'high',
          }),
        ),
        { engine: 'claude', model: 'opus', effort: 'high' },
      );
      assert.deepStrictEqual(
        engine.engineLabel(config({ engine: 'claude', claudeModel: '' })),
        { engine: 'claude', model: 'sonnet', effort: 'low' },
      );
    });

    test('codex shows `default` when no model is configured', function () {
      assert.deepStrictEqual(
        engine.engineLabel(
          config({ engine: 'codex', codexModel: '', codexEffort: 'medium' }),
        ),
        { engine: 'codex', model: 'default', effort: 'medium' },
      );
      assert.deepStrictEqual(
        engine.engineLabel(config({ engine: 'codex', codexModel: 'gpt-5' })),
        { engine: 'codex', model: 'gpt-5', effort: 'low' },
      );
    });

    test('custom names its binary and has no effort', function () {
      assert.deepStrictEqual(
        engine.engineLabel(
          config({ engine: 'custom', command: ['/bin/llm', '--flag'] }),
        ),
        { engine: 'custom', model: '/bin/llm', effort: 'n/a' },
      );
      assert.deepStrictEqual(
        engine.engineLabel(config({ engine: 'custom', command: [] })),
        { engine: 'custom', model: '', effort: 'n/a' },
      );
    });

    test('copilot names the claude model and effort it will run', function () {
      assert.deepStrictEqual(
        engine.engineLabel(
          config({
            engine: 'copilot',
            claudeModel: 'fable',
            claudeEffort: 'high',
          }),
        ),
        { engine: 'copilot', model: 'fable', effort: 'high' },
      );
      assert.deepStrictEqual(
        engine.engineLabel(config({ engine: 'copilot', claudeModel: '' })),
        { engine: 'copilot', model: 'sonnet', effort: 'low' },
      );
    });

    test('HELP_ENGINES is the four-engine list with claude the default', function () {
      assert.deepStrictEqual(Array.from(engine.HELP_ENGINES), [
        'claude',
        'codex',
        'copilot',
        'custom',
      ]);
      assert.deepStrictEqual(Array.from(engine.CLI_ENGINES), [
        'claude',
        'codex',
        'copilot',
      ]);
      assert.strictEqual(engine.DEFAULT_HELP_ENGINE, 'claude');
      assert.ok(engine.isCliEngine('copilot'));
      assert.ok(!engine.isCliEngine('custom'));
    });
  });

  // ----------------------------------------------------------- runHelpEngine

  suite('runHelpEngine — success', function () {
    test('claude: the answer comes out of the JSON on stdout', async function () {
      const spawn = makeSpawn(function (call) {
        call.finish({
          stdout: JSON.stringify({
            result: '### What it says\nHello',
            is_error: false,
          }),
          code: 0,
        });
      });
      const result = await engine.runHelpEngine(
        request({
          config: config({ binaryPath: { claude: fakeBinary } }),
        }),
        deps(spawn),
      );
      assert.strictEqual(result.markdown, '### What it says\nHello');
      assert.deepStrictEqual(result.label, {
        engine: 'claude',
        model: 'sonnet',
        effort: 'low',
      });
      assert.ok(typeof result.durationMs === 'number');

      assert.strictEqual(spawn.calls.length, 1);
      const call = spawn.calls[0];
      assert.strictEqual(call.file, fakeBinary);
      assert.strictEqual(call.stdin, 'USER');
      assert.ok(call.stdinEnded, 'stdin must be closed after the prompt');
      // Never a shell, and never the caller's own directory.
      assert.strictEqual(call.options.shell, undefined);
      assert.ok(call.options.cwd && call.options.cwd !== process.cwd());
      assert.deepStrictEqual(call.options.stdio, ['pipe', 'pipe', 'pipe']);
    });

    test('claude: the empty cwd is created and removed again', async function () {
      let seen;
      let listing;
      const spawn = makeSpawn(function (call) {
        seen = call.options.cwd;
        listing = fs.readdirSync(seen);
        call.finish({ stdout: '{"result":"ok"}', code: 0 });
      });
      await engine.runHelpEngine(
        request({ config: config({ binaryPath: { claude: fakeBinary } }) }),
        deps(spawn),
      );
      assert.ok(seen, 'the child was spawned');
      assert.deepStrictEqual(listing, [], 'no CLAUDE.md or AGENTS.md to load');
      assert.strictEqual(fs.existsSync(seen), false);
    });

    test('codex: the answer is the file it wrote, not its stdout', async function () {
      const spawn = makeSpawn(function (call) {
        const file = call.args[call.args.indexOf('-o') + 1];
        fs.writeFileSync(file, '### From the file\nbody\n', 'utf8');
        call.finish({
          stdout: 'progress: thinking\nprogress: done\n',
          code: 0,
        });
      });
      const result = await engine.runHelpEngine(
        request({
          config: config({
            engine: 'codex',
            codexModel: 'gpt-5',
            codexEffort: 'high',
            binaryPath: { codex: fakeBinary },
          }),
        }),
        deps(spawn),
      );
      assert.strictEqual(result.markdown, '### From the file\nbody\n');
      assert.ok(!result.markdown.includes('progress'));
      assert.deepStrictEqual(result.label, {
        engine: 'codex',
        model: 'gpt-5',
        effort: 'high',
      });
      assert.strictEqual(spawn.calls[0].stdin, request().codexPrompt);
    });

    test('custom: the answer is stdout', async function () {
      const spawn = makeSpawn(function (call) {
        call.finish({ stdout: 'plain markdown answer', code: 0 });
      });
      const result = await engine.runHelpEngine(
        request({
          config: config({
            engine: 'custom',
            command: [fakeBinary, '--one', 'two'],
          }),
        }),
        deps(spawn),
      );
      assert.strictEqual(result.markdown, 'plain markdown answer');
      assert.deepStrictEqual(result.label, {
        engine: 'custom',
        model: fakeBinary,
        effort: 'n/a',
      });
      assert.strictEqual(spawn.calls[0].file, fakeBinary);
      assert.deepStrictEqual(spawn.calls[0].args, ['--one', 'two']);
    });
  });

  suite('runHelpEngine — copilot', function () {
    const HELP_CONFIG =
      'Configuration Settings:\n\n  `model`: AI model to use.\n    - "claude-sonnet-5"\n    - "claude-fable-5.1"\n    - "gpt-5.5"\n\n  `theme`: x\n';

    function loggingDeps(spawn, lines) {
      return {
        spawn,
        log: function (line) {
          lines.push(line);
        },
        env: { PATH: '/usr/bin', SHELL: '/bin/zsh' },
      };
    }

    test('`help config` first, then the run; the answer is stdout and the usage file is read', async function () {
      let homeSeen;
      let homeExisted;
      let cwdSeen;
      const spawn = makeSpawn(function (call) {
        if (call.args[0] === 'help') {
          assert.deepStrictEqual(call.args, ['help', 'config']);
          call.finish({ stdout: HELP_CONFIG, code: 0 });
          return;
        }
        cwdSeen = call.options.cwd;
        homeSeen = call.options.env.COPILOT_HOME;
        homeExisted = fs.existsSync(homeSeen);
        const usage = call.args[call.args.indexOf('--usage-output-file') + 1];
        fs.writeFileSync(
          usage,
          JSON.stringify({
            totalPremiumRequestCost: 1,
            tokenDetails: {
              cache_read: { tokenCount: 1630 },
              cache_write: { tokenCount: 2053 },
              output: { tokenCount: 50 },
            },
          }),
          'utf8',
        );
        call.finish({ stdout: '### What it says\nHello\n\n', code: 0 });
      });
      const lines = [];
      const result = await engine.runHelpEngine(
        request({
          config: config({
            engine: 'copilot',
            claudeModel: 'fable',
            claudeEffort: 'medium',
            binaryPath: { copilot: fakeBinary },
          }),
        }),
        loggingDeps(spawn, lines),
      );
      assert.strictEqual(result.markdown, '### What it says\nHello\n\n');
      assert.deepStrictEqual(result.label, {
        engine: 'copilot',
        model: 'fable',
        effort: 'medium',
      });
      assert.strictEqual(result.model, 'claude-fable-5.1');
      assert.strictEqual(result.cacheRead, 1630);
      assert.strictEqual(result.cacheCreation, 2053);
      assert.strictEqual(result.premiumRequests, 1);
      assert.strictEqual(result.costUsd, undefined);

      assert.strictEqual(spawn.calls.length, 2);
      const run = spawn.calls[1];
      assert.strictEqual(run.file, fakeBinary);
      assert.strictEqual(run.args[0], '-p');
      assert.strictEqual(run.args[1], request().codexPrompt);
      assert.ok(run.args.includes('claude-fable-5.1'));
      assert.ok(run.args.includes('medium'));
      assert.strictEqual(run.stdin, '');
      assert.ok(run.stdinEnded, 'stdin is closed at once');
      assert.strictEqual(run.options.shell, undefined);
      assert.strictEqual(homeSeen, path.join(cwdSeen, 'copilot-home'));
      assert.ok(homeExisted, 'the throwaway home is made before the run');
      assert.strictEqual(
        spawn.calls[0].options.env.COPILOT_HOME,
        homeSeen,
        'help config runs against the throwaway home too',
      );
      assert.strictEqual(
        fs.existsSync(cwdSeen),
        false,
        'the cwd, home included, is removed',
      );
      assert.ok(
        lines.some((line) => line.includes('fable → claude-fable-5.1 (alias)')),
        lines.join('\n'),
      );
    });

    test('an unreadable catalog falls back to the built-in list, and says so', async function () {
      const spawn = makeSpawn(function (call) {
        if (call.args[0] === 'help') {
          call.finish({ stderr: 'boom', code: 1 });
          return;
        }
        call.finish({ stdout: 'ok', code: 0 });
      });
      const lines = [];
      const result = await engine.runHelpEngine(
        request({
          config: config({
            engine: 'copilot',
            binaryPath: { copilot: fakeBinary },
          }),
        }),
        loggingDeps(spawn, lines),
      );
      assert.strictEqual(result.markdown, 'ok');
      assert.strictEqual(result.model, 'claude-sonnet-5');
      assert.strictEqual(
        result.cacheRead,
        undefined,
        'no usage file, no cache column',
      );
      assert.ok(lines.some((line) => line.includes('built-in list')));
    });

    test('the catalog is cached per binary until clearHelpBinaryCache', async function () {
      const spawn = makeSpawn(function (call) {
        if (call.args[0] === 'help') {
          call.finish({ stdout: HELP_CONFIG, code: 0 });
          return;
        }
        call.finish({ stdout: 'ok', code: 0 });
      });
      const req = request({
        config: config({
          engine: 'copilot',
          binaryPath: { copilot: fakeBinary },
        }),
      });
      await engine.runHelpEngine(req, deps(spawn));
      await engine.runHelpEngine(req, deps(spawn));
      assert.deepStrictEqual(
        spawn.calls.map((call) => call.args[0]),
        ['help', '-p', '-p'],
      );
      engine.clearHelpBinaryCache();
      await engine.runHelpEngine(req, deps(spawn));
      assert.deepStrictEqual(
        spawn.calls.map((call) => call.args[0]),
        ['help', '-p', '-p', 'help', '-p'],
      );
    });

    test('a caller-owned cwd keeps the home across calls and seeds it once', async function () {
      const own = fs.mkdtempSync(path.join(os.tmpdir(), 'mpe-retell-test-'));
      try {
        const spawn = makeSpawn(function (call) {
          if (call.args[0] === 'help') {
            call.finish({ stdout: HELP_CONFIG, code: 0 });
            return;
          }
          fs.writeFileSync(
            path.join(call.options.env.COPILOT_HOME, 'marker'),
            'x',
          );
          call.finish({ stdout: 'ok', code: 0 });
        });
        const req = request({
          config: config({
            engine: 'copilot',
            binaryPath: { copilot: fakeBinary },
          }),
          cwd: own,
        });
        await engine.runHelpEngine(req, deps(spawn));
        await engine.runHelpEngine(req, deps(spawn));
        assert.ok(fs.existsSync(path.join(own, 'copilot-home', 'marker')));
        assert.ok(fs.existsSync(own), 'not removed');
      } finally {
        fs.rmSync(own, { recursive: true, force: true });
      }
    });

    const FAMILY_CONFIG =
      'Configuration Settings:\n\n  `model`: AI model to use.\n    - "claude-sonnet-5"\n    - "claude-fable-5.1"\n    - "claude-fable-5"\n    - "claude-opus-5"\n    - "claude-haiku-4.5"\n\n  `theme`: x\n';
    const REFUSAL = (model) =>
      `Error: Model "${model}" from --model flag is not available.\n`;

    /**
     * A CLI whose plan serves only `served`; every other model is refused at
     * once. `noEffort` models refuse the flag instead, the way haiku does.
     */
    function planSpawn(served, noEffort) {
      return makeSpawn(function (call) {
        if (call.args[0] === 'help') {
          call.finish({ stdout: FAMILY_CONFIG, code: 0 });
          return;
        }
        const model = call.args[call.args.indexOf('--model') + 1];
        if (
          (noEffort || []).includes(model) &&
          call.args.includes('--effort')
        ) {
          call.finish({
            stderr: `Error: Model "${model}" does not support reasoning effort configuration (requested low).\n`,
            code: 1,
          });
          return;
        }
        if (served.includes(model)) {
          call.finish({ stdout: `answer from ${model}`, code: 0 });
        } else {
          call.finish({ stderr: REFUSAL(model), code: 1 });
        }
      });
    }

    function modelsTried(spawn) {
      return spawn.calls
        .filter((call) => call.args[0] === '-p')
        .map((call) => call.args[call.args.indexOf('--model') + 1]);
    }

    test('a model the plan refuses is stepped down within its family, and logged', async function () {
      const spawn = planSpawn(['claude-fable-5', 'claude-sonnet-5']);
      const lines = [];
      const result = await engine.runHelpEngine(
        request({
          config: config({
            engine: 'copilot',
            claudeModel: 'fable',
            binaryPath: { copilot: fakeBinary },
          }),
        }),
        loggingDeps(spawn, lines),
      );
      assert.strictEqual(result.model, 'claude-fable-5');
      assert.strictEqual(result.markdown, 'answer from claude-fable-5');
      assert.deepStrictEqual(modelsTried(spawn), [
        'claude-fable-5.1',
        'claude-fable-5',
      ]);
      assert.ok(
        lines.some((line) =>
          line.includes(
            'claude-fable-5.1 is not available on this Copilot plan; trying the next fable model',
          ),
        ),
        lines.join('\n'),
      );
    });

    test('a pinned id the plan refuses steps down the same way', async function () {
      const spawn = planSpawn(['claude-fable-5']);
      const result = await engine.runHelpEngine(
        request({
          config: config({
            engine: 'copilot',
            claudeModel: 'claude-fable-5-1',
            binaryPath: { copilot: fakeBinary },
          }),
        }),
        deps(spawn),
      );
      assert.strictEqual(result.model, 'claude-fable-5');
    });

    test('when the whole family is refused the error names the models and is not retryable', async function () {
      const spawn = planSpawn(['claude-sonnet-5']);
      const error = await rejection(
        engine.runHelpEngine(
          request({
            config: config({
              engine: 'copilot',
              claudeModel: 'fable',
              binaryPath: { copilot: fakeBinary },
            }),
          }),
          deps(spawn),
        ),
      );
      assert.strictEqual(error.code, 'engine_failed');
      assert.strictEqual(error.retryable, false);
      assert.ok(
        error.message.includes(
          'claude-fable-5.1, claude-fable-5 are not available on this Copilot plan',
        ),
        error.message,
      );
      assert.ok(error.message.includes('Choose Help Model'), error.message);
      // One run per fable model, then nothing left to try: sonnet is never
      // reached on its own.
      assert.deepStrictEqual(modelsTried(spawn), [
        'claude-fable-5.1',
        'claude-fable-5',
      ]);
    });

    test('an id outside the catalog is tried once and never crosses into another family', async function () {
      const spawn = planSpawn(['claude-sonnet-5']);
      const error = await rejection(
        engine.runHelpEngine(
          request({
            config: config({
              engine: 'copilot',
              claudeModel: 'claude-mythos-6',
              binaryPath: { copilot: fakeBinary },
            }),
          }),
          deps(spawn),
        ),
      );
      assert.strictEqual(error.code, 'engine_failed');
      assert.ok(
        error.message.includes('claude-mythos-6 is not available'),
        error.message,
      );
      assert.deepStrictEqual(modelsTried(spawn), ['claude-mythos-6']);
    });

    test('a model that takes no --effort gets the prompt again without one', async function () {
      const spawn = planSpawn(['claude-haiku-4.5'], ['claude-haiku-4.5']);
      const lines = [];
      const result = await engine.runHelpEngine(
        request({
          config: config({
            engine: 'copilot',
            claudeModel: 'haiku',
            binaryPath: { copilot: fakeBinary },
          }),
        }),
        loggingDeps(spawn, lines),
      );
      assert.strictEqual(result.model, 'claude-haiku-4.5');
      assert.strictEqual(result.markdown, 'answer from claude-haiku-4.5');
      const runs = spawn.calls.filter((call) => call.args[0] === '-p');
      assert.strictEqual(runs.length, 2);
      assert.ok(runs[0].args.includes('--effort'));
      assert.ok(!runs[1].args.includes('--effort'));
      assert.ok(
        lines.some((line) => line.includes('takes no --effort')),
        lines.join('\n'),
      );
    });

    test('any other non-zero exit is the ordinary engine_failed, tried once', async function () {
      const spawn = makeSpawn(function (call) {
        if (call.args[0] === 'help') {
          call.finish({ stdout: FAMILY_CONFIG, code: 0 });
          return;
        }
        call.finish({ stderr: 'rate limited', code: 1 });
      });
      const error = await rejection(
        engine.runHelpEngine(
          request({
            config: config({
              engine: 'copilot',
              claudeModel: 'fable',
              binaryPath: { copilot: fakeBinary },
            }),
          }),
          deps(spawn),
        ),
      );
      assert.strictEqual(error.code, 'engine_failed');
      assert.strictEqual(error.retryable, true);
      assert.strictEqual(spawn.calls.length, 2);
    });

    test('parseCopilotUsage reads the usage file and ignores anything else', function () {
      assert.deepStrictEqual(
        engine.parseCopilotUsage(
          JSON.stringify({
            totalPremiumRequestCost: 2,
            tokenDetails: {
              cache_read: { tokenCount: 5 },
              cache_write: { tokenCount: 0 },
            },
          }),
        ),
        { cacheRead: 5, cacheCreation: 0, premiumRequests: 2 },
      );
      assert.strictEqual(engine.parseCopilotUsage('{}'), undefined);
      assert.strictEqual(engine.parseCopilotUsage('not json'), undefined);
      assert.strictEqual(engine.parseCopilotUsage('[1]'), undefined);
    });
  });

  suite('runHelpEngine — failures', function () {
    test('a non-zero exit is engine_failed, with the stderr excerpt', async function () {
      const spawn = makeSpawn(function (call) {
        call.finish({
          stderr: 'the model refused\nsecond line',
          code: 2,
        });
      });
      const error = await rejection(
        engine.runHelpEngine(
          request({ config: config({ binaryPath: { claude: fakeBinary } }) }),
          deps(spawn),
        ),
      );
      assert.strictEqual(error.name, 'HelpEngineError');
      assert.strictEqual(error.code, 'engine_failed');
      assert.strictEqual(error.retryable, true);
      assert.ok(error.message.includes('exited with code 2'), error.message);
      assert.ok(
        error.message.includes('the model refused second line'),
        error.message,
      );
    });

    test('the stderr excerpt is capped', async function () {
      const spawn = makeSpawn(function (call) {
        call.finish({ stderr: 'x'.repeat(1000), code: 1 });
      });
      const error = await rejection(
        engine.runHelpEngine(
          request({ config: config({ binaryPath: { claude: fakeBinary } }) }),
          deps(spawn),
        ),
      );
      assert.ok(error.message.includes('…'), error.message);
      assert.ok(
        error.message.length < 1000,
        `message was ${error.message.length} chars`,
      );
    });

    test('an auth failure on stderr is engine_auth and is not retryable', async function () {
      for (const stderr of [
        'Error: Invalid API key · Please run /login',
        'You are not logged in. Run codex login.',
        'HTTP 401 Unauthorized',
      ]) {
        const spawn = makeSpawn(function (call) {
          call.finish({ stderr, code: 1 });
        });
        const error = await rejection(
          engine.runHelpEngine(
            request({ config: config({ binaryPath: { claude: fakeBinary } }) }),
            deps(spawn),
          ),
        );
        assert.strictEqual(error.code, 'engine_auth', stderr);
        assert.strictEqual(error.retryable, false, stderr);
        assert.ok(error.message.includes('not signed in'), error.message);
      }
    });

    test('an auth failure reported inside the claude JSON is engine_auth too', async function () {
      const spawn = makeSpawn(function (call) {
        call.finish({
          stdout: JSON.stringify({
            result: 'Invalid API key. Please run /login',
            is_error: true,
          }),
          code: 0,
        });
      });
      const error = await rejection(
        engine.runHelpEngine(
          request({ config: config({ binaryPath: { claude: fakeBinary } }) }),
          deps(spawn),
        ),
      );
      assert.strictEqual(error.code, 'engine_auth');
      assert.strictEqual(error.retryable, false);
    });

    test('a non-auth error inside the claude JSON is engine_failed', async function () {
      const spawn = makeSpawn(function (call) {
        call.finish({
          stdout: JSON.stringify({
            result: 'context too long',
            is_error: true,
          }),
          code: 0,
        });
      });
      const error = await rejection(
        engine.runHelpEngine(
          request({ config: config({ binaryPath: { claude: fakeBinary } }) }),
          deps(spawn),
        ),
      );
      assert.strictEqual(error.code, 'engine_failed');
      assert.strictEqual(error.retryable, true);
      assert.ok(error.message.includes('context too long'), error.message);
    });

    test('an empty answer is engine_empty, whatever the engine', async function () {
      const cases = [
        [
          config({ binaryPath: { claude: fakeBinary } }),
          { stdout: '', code: 0 },
        ],
        [
          config({ binaryPath: { claude: fakeBinary } }),
          { stdout: '{"result":"   "}', code: 0 },
        ],
        [
          config({ engine: 'custom', command: [fakeBinary] }),
          { stdout: '\n \n', code: 0 },
        ],
        [
          config({ engine: 'codex', binaryPath: { codex: fakeBinary } }),
          { stdout: 'progress only', code: 0 },
        ],
      ];
      for (const [cfg, result] of cases) {
        const spawn = makeSpawn(function (call) {
          call.finish(result);
        });
        const error = await rejection(
          engine.runHelpEngine(request({ config: cfg }), deps(spawn)),
        );
        assert.strictEqual(error.code, 'engine_empty', JSON.stringify(result));
        assert.strictEqual(error.retryable, true);
      }
    });

    test('a spawn ENOENT is engine_not_found, not engine_failed', async function () {
      const spawn = makeSpawn(function (call) {
        const error = new Error('spawn ENOENT');
        error.code = 'ENOENT';
        call.child.emit('error', error);
      });
      const error = await rejection(
        engine.runHelpEngine(
          request({ config: config({ binaryPath: { claude: fakeBinary } }) }),
          deps(spawn),
        ),
      );
      assert.strictEqual(error.code, 'engine_not_found');
      assert.strictEqual(error.retryable, false);
    });

    test('any other spawn error is a retryable engine_failed', async function () {
      const spawn = makeSpawn(function (call) {
        const error = new Error('EPIPE');
        error.code = 'EPIPE';
        call.child.emit('error', error);
      });
      const error = await rejection(
        engine.runHelpEngine(
          request({ config: config({ binaryPath: { claude: fakeBinary } }) }),
          deps(spawn),
        ),
      );
      assert.strictEqual(error.code, 'engine_failed');
      assert.strictEqual(error.retryable, true);
    });
  });

  suite('runHelpEngine — the argument ceiling', function () {
    test('a prompt too long for one argument (E2BIG) is engine_failed and not retryable', async function () {
      const spawn = makeSpawn(function (call) {
        if (call.args[0] === 'help') {
          call.finish({ code: 1 });
          return;
        }
        const error = new Error('spawn E2BIG');
        error.code = 'E2BIG';
        call.child.emit('error', error);
      });
      const error = await rejection(
        engine.runHelpEngine(
          request({
            config: config({
              engine: 'copilot',
              binaryPath: { copilot: fakeBinary },
            }),
          }),
          deps(spawn),
        ),
      );
      assert.strictEqual(error.code, 'engine_failed');
      assert.strictEqual(error.retryable, false);
      assert.ok(/too long/.test(error.message), error.message);
    });
  });

  suite('runHelpEngine — the kill paths', function () {
    test('a timeout is engine_timeout and SIGTERMs the child', async function () {
      const spawn = makeHangingSpawn();
      const error = await withCompressedTimers(function () {
        return rejection(
          engine.runHelpEngine(
            request({
              config: config({
                binaryPath: { claude: fakeBinary },
                timeoutSeconds: 15,
              }),
            }),
            deps(spawn),
          ),
        );
      });
      assert.strictEqual(error.code, 'engine_timeout');
      assert.strictEqual(error.retryable, true);
      assert.ok(error.message.includes('15 s'), error.message);
      assert.deepStrictEqual(spawn.calls[0].signals, ['SIGTERM']);
    });

    test('an abort mid-run is `cancelled` and SIGTERMs the child', async function () {
      const controller = new AbortController();
      const spawn = makeHangingSpawn(function (call) {
        // The child has started and said something; the listener presses stop.
        call.child.stdout.emit('data', Buffer.from('partial'));
        controller.abort();
      });
      const error = await rejection(
        engine.runHelpEngine(
          request({
            config: config({ binaryPath: { claude: fakeBinary } }),
            signal: controller.signal,
          }),
          deps(spawn),
        ),
      );
      assert.strictEqual(error.code, 'cancelled');
      assert.strictEqual(error.retryable, false);
      assert.deepStrictEqual(spawn.calls[0].signals, ['SIGTERM']);
    });

    test('a signal already aborted never waits for the child', async function () {
      const controller = new AbortController();
      controller.abort();
      const spawn = makeHangingSpawn();
      const error = await rejection(
        engine.runHelpEngine(
          request({
            config: config({ binaryPath: { claude: fakeBinary } }),
            signal: controller.signal,
          }),
          deps(spawn),
        ),
      );
      assert.strictEqual(error.code, 'cancelled');
      assert.deepStrictEqual(spawn.calls[0].signals, ['SIGTERM']);
    });

    test('the working directory is removed even when the run is killed', async function () {
      let cwd;
      const controller = new AbortController();
      const spawn = makeHangingSpawn(function (call) {
        cwd = call.options.cwd;
        controller.abort();
      });
      await rejection(
        engine.runHelpEngine(
          request({
            config: config({ binaryPath: { claude: fakeBinary } }),
            signal: controller.signal,
          }),
          deps(spawn),
        ),
      );
      assert.ok(cwd, 'the child was spawned');
      assert.strictEqual(fs.existsSync(cwd), false);
    });
  });

  suite('§7.3 the binary lookup', function () {
    test('custom with an empty command names the setting to fill in', async function () {
      const spawn = makeSpawn(function () {});
      const error = await rejection(
        engine.runHelpEngine(
          request({ config: config({ engine: 'custom', command: [] }) }),
          deps(spawn),
        ),
      );
      assert.strictEqual(error.code, 'engine_not_found');
      assert.strictEqual(error.retryable, false);
      assert.ok(
        error.message.includes(
          'markdown-preview-enhanced.readAloudHelpCommand',
        ),
        error.message,
      );
      assert.strictEqual(spawn.calls.length, 0);
    });

    test('an empty PATH and no login shell is engine_not_found, naming what was tried', async function () {
      const emptyDir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'mpe-help-empty-'),
      );
      const missingShell = path.join(emptyDir, 'no-such-shell');
      try {
        const spawn = makeSpawn(function (call) {
          // The login-shell fallback is the only child here; it finds nothing.
          call.finish({ code: 1 });
        });
        const error = await rejection(
          engine.runHelpEngine(
            request({ config: config({ binaryPath: {} }) }),
            deps(spawn, { PATH: emptyDir, SHELL: missingShell }),
          ),
        );
        assert.strictEqual(error.code, 'engine_not_found');
        assert.strictEqual(error.retryable, false);
        assert.ok(
          error.message.includes('Could not find the claude command'),
          error.message,
        );
        assert.ok(error.message.includes(`PATH (${emptyDir})`), error.message);
        assert.ok(
          error.message.includes(`${missingShell} -lic "which -a claude"`),
          error.message,
        );
        assert.ok(
          error.message.includes(
            'markdown-preview-enhanced.readAloudHelpBinaryPath.claude',
          ),
          error.message,
        );

        // The spawns were login-shell lookups, with our own constants:
        // claude's, then the other two CLIs' for the "installed here" line.
        assert.strictEqual(spawn.calls.length, 3);
        assert.ok(spawn.calls.every((call) => call.file === missingShell));
        assert.deepStrictEqual(spawn.calls[0].args, [
          '-lic',
          'which -a claude',
        ]);
        assert.deepStrictEqual(spawn.calls.map((call) => call.args[1]).sort(), [
          'which -a claude',
          'which -a codex',
          'which -a copilot',
        ]);
        assert.ok(!error.message.includes('Installed here'), error.message);
      } finally {
        fs.rmSync(emptyDir, { recursive: true, force: true });
      }
    });

    test('resolveHelpBinary takes an absolute, executable override first', async function () {
      const spawn = makeSpawn(function () {});
      const lookup = await engine.resolveHelpBinary(
        'claude',
        fakeBinary,
        deps(spawn, { PATH: '', SHELL: '/no/shell' }),
      );
      assert.strictEqual(lookup.path, fakeBinary);
      assert.deepStrictEqual(lookup.tried, [
        `readAloudHelpBinaryPath.claude (${fakeBinary})`,
      ]);
      assert.strictEqual(spawn.calls.length, 0);
    });

    test('a relative or non-executable override falls through to the PATH', async function () {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpe-help-path-'));
      const onPath = path.join(dir, 'claude');
      fs.writeFileSync(onPath, '#!/bin/sh\nexit 0\n', 'utf8');
      fs.chmodSync(onPath, 0o755);
      try {
        const spawn = makeSpawn(function (call) {
          call.finish({ code: 1 });
        });
        const lookup = await engine.resolveHelpBinary(
          'claude',
          'claude',
          deps(spawn, { PATH: dir, SHELL: '/no/shell' }),
        );
        assert.strictEqual(lookup.path, onPath);
        assert.ok(lookup.tried[0].startsWith('readAloudHelpBinaryPath.claude'));
        assert.ok(lookup.tried[1].startsWith('PATH ('));
        assert.strictEqual(spawn.calls.length, 0);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    test('the PATH result is cached per name until clearHelpBinaryCache', async function () {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpe-help-cache-'));
      const onPath = path.join(dir, 'codex');
      fs.writeFileSync(onPath, '#!/bin/sh\nexit 0\n', 'utf8');
      fs.chmodSync(onPath, 0o755);
      try {
        const spawn = makeSpawn(function (call) {
          call.finish({ code: 1 });
        });
        const first = await engine.resolveHelpBinary(
          'codex',
          undefined,
          deps(spawn, { PATH: dir, SHELL: '/no/shell' }),
        );
        assert.strictEqual(first.path, onPath);

        // A second lookup with a PATH that no longer contains it still hits.
        const cached = await engine.resolveHelpBinary(
          'codex',
          undefined,
          deps(spawn, { PATH: '', SHELL: '/no/shell' }),
        );
        assert.strictEqual(cached.path, onPath);
        assert.deepStrictEqual(cached.tried, []);

        engine.clearHelpBinaryCache();
        const cleared = await engine.resolveHelpBinary(
          'codex',
          undefined,
          deps(spawn, { PATH: '', SHELL: '/no/shell' }),
        );
        assert.strictEqual(cleared.path, undefined);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    test('the login shell answers with an absolute, executable path', async function () {
      const spawn = makeSpawn(function (call) {
        call.finish({ stdout: `${fakeBinary}\n`, code: 0 });
      });
      const lookup = await engine.resolveHelpBinary(
        'claude',
        undefined,
        deps(spawn, { PATH: '', SHELL: '/bin/zsh' }),
      );
      assert.strictEqual(lookup.path, fakeBinary);
      assert.strictEqual(spawn.calls[0].file, '/bin/zsh');
      assert.deepStrictEqual(spawn.calls[0].args, ['-lic', 'which -a claude']);
    });

    test("VS Code's Copilot Chat launcher is never the copilot binary", async function () {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mpe-help-shim-'));
      const shimDir = path.join(root, 'github.copilot-chat', 'copilotCli');
      const realDir = path.join(root, 'real');
      fs.mkdirSync(shimDir, { recursive: true });
      fs.mkdirSync(realDir);
      const shim = path.join(shimDir, 'copilot');
      const real = path.join(realDir, 'copilot');
      for (const file of [shim, real]) {
        fs.writeFileSync(file, '#!/bin/sh\nexit 0\n', 'utf8');
        fs.chmodSync(file, 0o755);
      }
      try {
        const spawn = makeSpawn(function (call) {
          call.finish({ code: 1 });
        });
        // The shim ahead of the real CLI on the PATH: the real one wins.
        const both = await engine.resolveHelpBinary(
          'copilot',
          undefined,
          deps(spawn, {
            PATH: `${shimDir}${path.delimiter}${realDir}`,
            SHELL: '/no/shell',
          }),
        );
        assert.strictEqual(both.path, real);

        // The shim alone (on the PATH twice): not found, and the report
        // says why, naming it once.
        engine.clearHelpBinaryCache();
        const alone = await engine.resolveHelpBinary(
          'copilot',
          undefined,
          deps(spawn, {
            PATH: `${shimDir}${path.delimiter}${shimDir}`,
            SHELL: '/no/shell',
          }),
        );
        assert.strictEqual(alone.path, undefined);
        assert.strictEqual(
          alone.tried.join(' ').split(shim).length - 1,
          1,
          'the launcher is named once',
        );
        assert.ok(
          alone.tried.some(
            (entry) =>
              entry.includes('Copilot Chat launcher') && entry.includes(shim),
          ),
          alone.tried.join('; '),
        );

        // As the override it is refused too.
        engine.clearHelpBinaryCache();
        const override = await engine.resolveHelpBinary(
          'copilot',
          shim,
          deps(spawn, { PATH: '', SHELL: '/no/shell' }),
        );
        assert.strictEqual(override.path, undefined);

        // And the login shell's `which -a` lists it first: skipped, the
        // real CLI after it taken.
        engine.clearHelpBinaryCache();
        const shellSpawn = makeSpawn(function (call) {
          call.finish({ stdout: `${shim}\n${real}\n`, code: 0 });
        });
        const fromShell = await engine.resolveHelpBinary(
          'copilot',
          undefined,
          deps(shellSpawn, { PATH: '', SHELL: '/bin/zsh' }),
        );
        assert.strictEqual(fromShell.path, real);
        assert.deepStrictEqual(shellSpawn.calls[0].args, [
          '-lic',
          'which -a copilot',
        ]);

        // A claude at that path would be fine: the rule is copilot's alone.
        engine.clearHelpBinaryCache();
        const claudeShim = path.join(shimDir, 'claude');
        fs.copyFileSync(shim, claudeShim);
        const claude = await engine.resolveHelpBinary(
          'claude',
          undefined,
          deps(spawn, { PATH: shimDir, SHELL: '/no/shell' }),
        );
        assert.strictEqual(claude.path, claudeShim);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    test('the login shell answer is read from the end: rc-file noise, then the paths', async function () {
      const spawn = makeSpawn(function (call) {
        call.finish({
          stdout: `Welcome!\nnot a path\n${fakeBinary}\n`,
          code: 0,
        });
      });
      const lookup = await engine.resolveHelpBinary(
        'claude',
        undefined,
        deps(spawn, { PATH: '', SHELL: '/bin/zsh' }),
      );
      assert.strictEqual(lookup.path, fakeBinary);
    });

    test('a missing engine names the CLIs that are installed and the command that switches', async function () {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpe-help-other-'));
      const copilot = path.join(dir, 'copilot');
      fs.writeFileSync(copilot, '#!/bin/sh\nexit 0\n', 'utf8');
      fs.chmodSync(copilot, 0o755);
      try {
        const spawn = makeSpawn(function (call) {
          call.finish({ code: 1 });
        });
        const error = await rejection(
          engine.runHelpEngine(
            request({ config: config({ engine: 'claude' }) }),
            deps(spawn, { PATH: dir, SHELL: '/no/shell' }),
          ),
        );
        assert.strictEqual(error.code, 'engine_not_found');
        assert.ok(error.message.includes('Could not find the claude command'));
        assert.ok(
          error.message.includes('claude.ai/install.sh'),
          error.message,
        );
        assert.ok(
          error.message.includes(`Installed here: copilot (${copilot})`),
          error.message,
        );
        assert.ok(error.message.includes('Choose Help Engine'), error.message);
        assert.ok(
          !error.message.includes('codex ('),
          'codex is not installed here',
        );
        // copilot came off the PATH; claude and codex asked the login shell.
        assert.deepStrictEqual(spawn.calls.map((call) => call.args[1]).sort(), [
          'which -a claude',
          'which -a codex',
        ]);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    test('detectHelpBinaries looks every CLI engine up at once', async function () {
      const spawn = makeSpawn(function (call) {
        call.finish({ code: 1 });
      });
      const found = await engine.detectHelpBinaries(
        { claude: fakeBinary },
        deps(spawn, { PATH: '', SHELL: '/no/shell' }),
      );
      assert.strictEqual(found.claude.path, fakeBinary);
      assert.strictEqual(found.codex.path, undefined);
      assert.strictEqual(found.copilot.path, undefined);
      assert.deepStrictEqual(spawn.calls.map((call) => call.args[1]).sort(), [
        'which -a codex',
        'which -a copilot',
      ]);
    });

    test('a relative answer from the login shell is refused', async function () {
      const spawn = makeSpawn(function (call) {
        call.finish({ stdout: 'claude\n', code: 0 });
      });
      const lookup = await engine.resolveHelpBinary(
        'claude',
        undefined,
        deps(spawn, { PATH: '', SHELL: '/bin/zsh' }),
      );
      assert.strictEqual(lookup.path, undefined);
    });
  });
});

// ---------------------------------------------------------------------------

suite('read-aloud/help-answer', function () {
  this.timeout(20000);

  suiteSetup(async function () {
    answerBundle = path.join(__dirname, '.help-answer.bundle.cjs');
    answer = await compile('help-answer', answerBundle);
  });

  suiteTeardown(function () {
    if (answerBundle && fs.existsSync(answerBundle)) {
      fs.unlinkSync(answerBundle);
    }
  });

  suite('§6 sanitizeHelpAnswer', function () {
    test('every `<` becomes &lt;, so no tag can be produced', function () {
      const hostile = '<script>alert(1)</script> **x**';
      const safe = answer.sanitizeHelpAnswer(hostile);
      assert.strictEqual(safe, '&lt;script>alert(1)&lt;/script> **x**');
      assert.ok(!safe.includes('<'), safe);
      // The markdown around it is untouched.
      assert.ok(safe.endsWith('**x**'));
    });

    test('an img onerror and an autolink lose their angle bracket too', function () {
      assert.ok(
        !answer
          .sanitizeHelpAnswer('<img src=x onerror=alert(1)>')
          .includes('<'),
      );
      assert.ok(
        !answer.sanitizeHelpAnswer('<javascript:alert(1)>').includes('<'),
      );
    });

    test('a javascript: link target becomes about:blank#', function () {
      assert.strictEqual(
        answer.sanitizeHelpAnswer('[click](javascript:alert(1))'),
        '[click](about:blank#alert(1))',
      );
      assert.strictEqual(
        answer.sanitizeHelpAnswer('[click](JAVASCRIPT:alert(1))'),
        '[click](about:blank#alert(1))',
      );
      // The whitespace markdown-it allows is part of the kept prefix.
      assert.strictEqual(
        answer.sanitizeHelpAnswer('[click]( javascript\t:alert(1))'),
        '[click]( about:blank#alert(1))',
      );
    });

    test('a data: and a vbscript: target go the same way', function () {
      assert.strictEqual(
        answer.sanitizeHelpAnswer('[x](data:text/html;base64,AAAA)'),
        '[x](about:blank#text/html;base64,AAAA)',
      );
      assert.strictEqual(
        answer.sanitizeHelpAnswer('[x](vbscript:msgbox)'),
        '[x](about:blank#msgbox)',
      );
    });

    test('a reference definition is neutralised as well', function () {
      assert.strictEqual(
        answer.sanitizeHelpAnswer('[id]: javascript:alert(1)'),
        '[id]: about:blank#alert(1)',
      );
      assert.strictEqual(
        answer.sanitizeHelpAnswer('text\n   [id]:data:text/html,x\nmore'),
        'text\n   [id]:about:blank#text/html,x\nmore',
      );
    });

    test('an angle-bracket destination is already inert by then', function () {
      const safe = answer.sanitizeHelpAnswer('[x](<javascript:alert(1)>)');
      assert.ok(!safe.includes('<'), safe);
      assert.ok(!/\]\(\s*javascript:/i.test(safe), safe);
    });

    test('a safe link is left alone', function () {
      assert.strictEqual(
        answer.sanitizeHelpAnswer('[x](https://example.com/a?b=1)'),
        '[x](https://example.com/a?b=1)',
      );
      assert.strictEqual(
        answer.sanitizeHelpAnswer('the word javascript: on its own'),
        'the word javascript: on its own',
      );
    });

    test('the answer is capped at MAX_ANSWER_CHARS', function () {
      assert.strictEqual(
        answer.sanitizeHelpAnswer('a'.repeat(50000)).length,
        40000,
      );
      assert.strictEqual(answer.MAX_ANSWER_CHARS, 40000);
    });

    test('anything that is not a string is empty', function () {
      for (const value of [undefined, null, 42, {}, []]) {
        assert.strictEqual(answer.sanitizeHelpAnswer(value), '', String(value));
      }
    });
  });

  suite('normaliseHelpAnswer', function () {
    test('normalises CRLF and a bare CR, and trims', function () {
      assert.strictEqual(
        answer.normaliseHelpAnswer('  a\r\nb\rc  \n'),
        'a\nb\nc',
      );
    });

    test('strips a fence that wraps the whole answer', function () {
      assert.strictEqual(
        answer.normaliseHelpAnswer('```markdown\n### Hi\nthere\n```'),
        '### Hi\nthere',
      );
      assert.strictEqual(answer.normaliseHelpAnswer('```\nbody\n```'), 'body');
      assert.strictEqual(
        answer.normaliseHelpAnswer('\n```md\r\nbody\r\n```\n'),
        'body',
      );
    });

    test('leaves a fence that does not wrap the whole answer', function () {
      const text = 'intro\n```\ncode\n```';
      assert.strictEqual(answer.normaliseHelpAnswer(text), text);
      const trailing = '```\ncode\n```\noutro';
      assert.strictEqual(answer.normaliseHelpAnswer(trailing), trailing);
    });

    test('an empty or non-string answer is the empty string', function () {
      assert.strictEqual(answer.normaliseHelpAnswer(''), '');
      assert.strictEqual(answer.normaliseHelpAnswer('   \n  '), '');
      for (const value of [undefined, null, 42, {}]) {
        assert.strictEqual(
          answer.normaliseHelpAnswer(value),
          '',
          String(value),
        );
      }
    });
  });

  suite('13 §9.1 — a caller-owned cwd, and the cache column', function () {
    // This suite sits outside the engine suite's setup, so it makes its own
    // executable for the binary override.
    let ownBinDir;
    let fakeBinary;

    suiteSetup(function () {
      ownBinDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpe-help-bin-'));
      fakeBinary = path.join(ownBinDir, 'fake-cli');
      fs.writeFileSync(fakeBinary, '#!/bin/sh\nexit 0\n', 'utf8');
      fs.chmodSync(fakeBinary, 0o755);
      engine.clearHelpBinaryCache();
    });

    suiteTeardown(function () {
      if (ownBinDir && fs.existsSync(ownBinDir)) {
        fs.rmSync(ownBinDir, { recursive: true, force: true });
      }
    });

    test('with cwd given the child spawns there and the directory is left in place', async function () {
      const own = fs.mkdtempSync(path.join(os.tmpdir(), 'mpe-classroom-test-'));
      let seen;
      const spawn = makeSpawn(function (call) {
        seen = call.options.cwd;
        call.finish({
          stdout: JSON.stringify({
            result: 'ok',
            usage: {
              cache_read_input_tokens: 30016,
              cache_creation_input_tokens: 0,
            },
            total_cost_usd: 0.029,
          }),
          code: 0,
        });
      });
      const result = await engine.runHelpEngine(
        request({
          config: config({ binaryPath: { claude: fakeBinary } }),
          cwd: own,
        }),
        deps(spawn),
      );
      assert.strictEqual(seen, own);
      assert.strictEqual(fs.existsSync(own), true, 'not removed');
      assert.strictEqual(result.cacheRead, 30016);
      assert.strictEqual(result.cacheCreation, 0);
      assert.strictEqual(result.costUsd, 0.029);
      fs.rmSync(own, { recursive: true, force: true });
    });

    test('without cwd the engine makes and removes its own, and reports no usage without a block', async function () {
      let seen;
      const spawn = makeSpawn(function (call) {
        seen = call.options.cwd;
        call.finish({ stdout: '{"result":"ok"}', code: 0 });
      });
      const result = await engine.runHelpEngine(
        request({ config: config({ binaryPath: { claude: fakeBinary } }) }),
        deps(spawn),
      );
      assert.ok(seen && seen.includes('mpe-help-'));
      assert.strictEqual(fs.existsSync(seen), false);
      assert.strictEqual(result.cacheRead, undefined);
      assert.strictEqual(result.costUsd, undefined);
    });

    test('a caller-owned cwd survives a killed run too', async function () {
      const own = fs.mkdtempSync(path.join(os.tmpdir(), 'mpe-classroom-test-'));
      const controller = new AbortController();
      const spawn = makeHangingSpawn(function () {
        controller.abort();
      });
      const error = await rejection(
        engine.runHelpEngine(
          request({
            config: config({ binaryPath: { claude: fakeBinary } }),
            signal: controller.signal,
            cwd: own,
          }),
          deps(spawn),
        ),
      );
      assert.strictEqual(error.code, 'cancelled');
      assert.strictEqual(fs.existsSync(own), true);
      fs.rmSync(own, { recursive: true, force: true });
    });

    test('parseClaudeJson surfaces the usage block only when there is one', function () {
      assert.deepStrictEqual(
        engine.parseClaudeJson(
          '{"result":"x","usage":{"cache_read_input_tokens":12,"cache_creation_input_tokens":3},"total_cost_usd":0.5}',
        ),
        {
          answer: 'x',
          usage: { cacheRead: 12, cacheCreation: 3, costUsd: 0.5 },
        },
      );
      assert.deepStrictEqual(
        engine.parseClaudeJson('{"result":"x","usage":{}}'),
        {
          answer: 'x',
        },
      );
    });
  });
});
