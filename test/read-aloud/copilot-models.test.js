/* global suite, test, suiteSetup, suiteTeardown, setup */

/**
 * `src/read-aloud/copilot-models.ts`: the model list of `copilot help config`
 * and the mapping from the Claude Code model setting to a Copilot id.
 *
 * The fixture is the `model` entry as Copilot CLI 1.0.83 printed it on
 * 2026-09-09, with the keys either side of it, so the parser is held to the
 * real shape: a description line, quoted bullets, a blank line, the next key.
 */

const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const esbuild = require('esbuild');

let models;
let bundle;

const HELP_CONFIG = [
  'Configuration Settings:',
  '',
  '  `logLevel`: log level for CLI; defaults to "default". Set to "all" for debug logging.',
  '',
  '  `model`: AI model to use for Copilot CLI; can be changed with /model command or --model flag option.',
  '    - "claude-sonnet-5"',
  '    - "claude-fable-5.1"',
  '    - "claude-fable-5"',
  '    - "claude-opus-5"',
  '    - "claude-opus-4.8"',
  '    - "claude-opus-4.8-fast"',
  '    - "claude-opus-4.7"',
  '    - "claude-sonnet-4.6"',
  '    - "claude-haiku-4.5"',
  '    - "gpt-5.6-sol"',
  '    - "gpt-5.5"',
  '    - "gemini-3.8-flash"',
  '',
  '  `contextTier`: context window tier; defaults to "default".',
  '    - "default"',
  '    - "long_context"',
  '',
].join('\n');

suite('read-aloud/copilot-models', function () {
  suiteSetup(async function () {
    bundle = path.join(__dirname, '.copilot-models.bundle.cjs');
    const result = await esbuild.build({
      entryPoints: [
        path.join(
          __dirname,
          '..',
          '..',
          'src',
          'read-aloud',
          'copilot-models.ts',
        ),
      ],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node18',
      write: false,
      logLevel: 'silent',
      external: ['vscode', 'crossnote'],
    });
    fs.writeFileSync(bundle, result.outputFiles[0].text);
    models = require(bundle);
  });

  suiteTeardown(function () {
    if (bundle && fs.existsSync(bundle)) {
      fs.unlinkSync(bundle);
    }
  });

  suite('parseCopilotCatalog', function () {
    test('reads the `model` bullets and stops at the blank line after them', function () {
      const ids = models.parseCopilotCatalog(HELP_CONFIG);
      assert.deepStrictEqual(ids, [
        'claude-sonnet-5',
        'claude-fable-5.1',
        'claude-fable-5',
        'claude-opus-5',
        'claude-opus-4.8',
        'claude-opus-4.8-fast',
        'claude-opus-4.7',
        'claude-sonnet-4.6',
        'claude-haiku-4.5',
        'gpt-5.6-sol',
        'gpt-5.5',
        'gemini-3.8-flash',
      ]);
      assert.ok(
        !ids.includes('default'),
        "the next key's bullets are not models",
      );
    });

    test('CRLF, no `model` key, and an empty text', function () {
      assert.deepStrictEqual(
        models.parseCopilotCatalog(HELP_CONFIG.replace(/\n/g, '\r\n')),
        models.parseCopilotCatalog(HELP_CONFIG),
      );
      assert.deepStrictEqual(
        models.parseCopilotCatalog('Configuration Settings:\n'),
        [],
      );
      assert.deepStrictEqual(models.parseCopilotCatalog(''), []);
    });

    test('the built-in fallback is what the parser reads from the fixture, Claude ids only', function () {
      const claude = models
        .parseCopilotCatalog(HELP_CONFIG)
        .filter((id) => id.startsWith('claude-'));
      assert.deepStrictEqual(
        Array.from(models.COPILOT_CLAUDE_MODELS_FALLBACK),
        claude,
      );
    });
  });

  suite('parseClaudeModelId', function () {
    test("Copilot's dotted form", function () {
      assert.deepStrictEqual(models.parseClaudeModelId('claude-fable-5.1'), {
        family: 'fable',
        version: [5, 1],
        suffix: '',
      });
      assert.deepStrictEqual(
        models.parseClaudeModelId('claude-opus-4.8-fast'),
        {
          family: 'opus',
          version: [4, 8],
          suffix: 'fast',
        },
      );
      assert.deepStrictEqual(models.parseClaudeModelId('claude-sonnet-5'), {
        family: 'sonnet',
        version: [5],
        suffix: '',
      });
    });

    test("Claude Code's dashed form, with and without a date", function () {
      assert.deepStrictEqual(models.parseClaudeModelId('claude-fable-5-1'), {
        family: 'fable',
        version: [5, 1],
        suffix: '',
      });
      assert.deepStrictEqual(
        models.parseClaudeModelId('claude-sonnet-4-5-20250929'),
        { family: 'sonnet', version: [4, 5], suffix: '' },
      );
      assert.deepStrictEqual(
        models.parseClaudeModelId('claude-haiku-4-5-20251001'),
        { family: 'haiku', version: [4, 5], suffix: '' },
      );
    });

    test('the old version-first form, and a latest suffix', function () {
      assert.deepStrictEqual(
        models.parseClaudeModelId('claude-3-5-sonnet-latest'),
        { family: 'sonnet', version: [3, 5], suffix: 'latest' },
      );
    });

    test('anything that is not a Claude id is undefined', function () {
      assert.strictEqual(models.parseClaudeModelId('gpt-5.5'), undefined);
      assert.strictEqual(models.parseClaudeModelId('claude-'), undefined);
      assert.strictEqual(models.parseClaudeModelId('claude-5'), undefined);
      assert.strictEqual(models.parseClaudeModelId(''), undefined);
    });

    test('formatCopilotModelId is the dotted form', function () {
      assert.strictEqual(
        models.formatCopilotModelId(
          models.parseClaudeModelId('claude-fable-5-1'),
        ),
        'claude-fable-5.1',
      );
      assert.strictEqual(
        models.formatCopilotModelId(
          models.parseClaudeModelId('claude-opus-4-8-fast'),
        ),
        'claude-opus-4.8-fast',
      );
      assert.strictEqual(
        models.formatCopilotModelId(
          models.parseClaudeModelId('claude-sonnet-4-5-20250929'),
        ),
        'claude-sonnet-4.5',
      );
    });
  });

  suite('copilotModelFor', function () {
    // The bundle is compiled in suiteSetup, so the catalog is read per test.
    let catalog;
    setup(function () {
      catalog = models.parseCopilotCatalog(HELP_CONFIG);
    });

    test('an alias is the newest plain model of its family, never a -fast variant', function () {
      assert.deepStrictEqual(models.copilotModelFor('sonnet', catalog), {
        id: 'claude-sonnet-5',
        how: 'alias',
      });
      assert.deepStrictEqual(models.copilotModelFor('fable', catalog), {
        id: 'claude-fable-5.1',
        how: 'alias',
      });
      assert.deepStrictEqual(models.copilotModelFor('opus', catalog), {
        id: 'claude-opus-5',
        how: 'alias',
      });
      assert.deepStrictEqual(models.copilotModelFor('haiku', catalog), {
        id: 'claude-haiku-4.5',
        how: 'alias',
      });
      // With opus 5 gone, 4.8 beats 4.8-fast and 4.7.
      const older = catalog.filter((id) => id !== 'claude-opus-5');
      assert.deepStrictEqual(models.copilotModelFor('opus', older), {
        id: 'claude-opus-4.8',
        how: 'alias',
      });
    });

    test('5.1 beats 5 and 4.10 beats 4.9: versions compare as numbers', function () {
      assert.strictEqual(
        models.newestCopilotModel('fable', [
          'claude-fable-5',
          'claude-fable-5.1',
        ]),
        'claude-fable-5.1',
      );
      assert.strictEqual(
        models.newestCopilotModel('opus', [
          'claude-opus-4.9',
          'claude-opus-4.10',
        ]),
        'claude-opus-4.10',
      );
    });

    test('a full id in either form is used exactly when the catalog has it', function () {
      assert.deepStrictEqual(
        models.copilotModelFor('claude-fable-5-1', catalog),
        {
          id: 'claude-fable-5.1',
          how: 'exact',
        },
      );
      assert.deepStrictEqual(
        models.copilotModelFor('claude-opus-4.8', catalog),
        {
          id: 'claude-opus-4.8',
          how: 'exact',
        },
      );
      assert.deepStrictEqual(
        models.copilotModelFor('claude-opus-4.8-fast', catalog),
        { id: 'claude-opus-4.8-fast', how: 'exact' },
      );
      assert.deepStrictEqual(
        models.copilotModelFor('Claude-Sonnet-5', catalog),
        {
          id: 'claude-sonnet-5',
          how: 'exact',
        },
      );
    });

    test('a pinned id the catalog lacks gets the newest of its family', function () {
      assert.deepStrictEqual(
        models.copilotModelFor('claude-sonnet-4-5-20250929', catalog),
        { id: 'claude-sonnet-5', how: 'family' },
      );
      assert.deepStrictEqual(
        models.copilotModelFor('claude-3-5-sonnet-latest', catalog),
        { id: 'claude-sonnet-5', how: 'family' },
      );
    });

    test('with nothing to go on the setting is passed through for the CLI to judge', function () {
      assert.deepStrictEqual(
        models.copilotModelFor('haiku', ['claude-sonnet-5']),
        {
          id: 'haiku',
          how: 'passthrough',
        },
      );
      assert.deepStrictEqual(
        models.copilotModelFor('claude-mythos-6', catalog),
        { id: 'claude-mythos-6', how: 'passthrough' },
      );
      assert.deepStrictEqual(models.copilotModelFor('gpt-5.5', catalog), {
        id: 'gpt-5.5',
        how: 'passthrough',
      });
    });

    test('the empty catalog and the fallback list agree on the aliases', function () {
      for (const alias of ['fable', 'opus', 'sonnet', 'haiku']) {
        assert.deepStrictEqual(
          models.copilotModelFor(alias, models.COPILOT_CLAUDE_MODELS_FALLBACK),
          models.copilotModelFor(alias, catalog),
        );
      }
    });
  });
});
