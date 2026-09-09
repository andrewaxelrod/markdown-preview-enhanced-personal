/**
 * The Copilot CLI's model catalog, and the mapping from the Claude Code model
 * setting to a Copilot model id.
 *
 * The `copilot` help engine runs the Claude model the `claude` engine is set
 * to, at the same effort (there is no Copilot model setting): the user
 * chooses a model once, and either CLI answers with it. The two CLIs name the
 * same models differently, which is what this module reconciles:
 *
 * - Claude Code takes an alias — `fable`, `opus`, `sonnet`, `haiku` — that
 *   always means its latest model of that name, or a full id with dashes
 *   (`claude-fable-5-1`, `claude-sonnet-4-5-20250929`).
 * - Copilot takes an id from its own catalog, with a dotted version:
 *   `claude-fable-5.1`, `claude-sonnet-4.6`, `claude-opus-4.8-fast`.
 *
 * The catalog is read from `copilot help config`, which prints the ids the
 * CLI knows without signing in or touching the network (about 200 ms), so an
 * alias resolves to the *newest* model of that family the installed CLI
 * offers, the way Claude Code's alias does. {@link COPILOT_CLAUDE_MODELS_FALLBACK}
 * is the list as printed on 2026-09-09 by Copilot CLI 1.0.83, for when the
 * help text cannot be read or parsed.
 *
 * Pure: no `vscode`, no `child_process`, so the parser and the mapping are
 * unit-tested in `test/read-aloud/copilot-models.test.js`.
 */

/** `copilot help config`, 1.0.83, 2026-09-09: the `model` bullets that start with `claude-`. */
export const COPILOT_CLAUDE_MODELS_FALLBACK: readonly string[] = [
  'claude-sonnet-5',
  'claude-fable-5.1',
  'claude-fable-5',
  'claude-opus-5',
  'claude-opus-4.8',
  'claude-opus-4.8-fast',
  'claude-opus-4.7',
  'claude-sonnet-4.6',
  'claude-haiku-4.5',
];

/** The families Claude Code's aliases name. */
export const CLAUDE_FAMILIES = ['fable', 'opus', 'sonnet', 'haiku'] as const;

/**
 * The model ids listed under `` `model` `` in `copilot help config`, in the
 * order printed; empty when the text carries no such list.
 *
 * The list is the bullet lines (`- "id"`) that follow the `model` key up to
 * the first blank line after them, so a later key's own bullets are never
 * taken for models.
 */
export function parseCopilotCatalog(helpConfigText: string): string[] {
  const lines = helpConfigText.split(/\r?\n/);
  const start = lines.findIndex((line) => /^\s*`model`\s*:/.test(line));
  if (start < 0) {
    return [];
  }
  const ids: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    const bullet = /^\s*-\s*"([^"\s]+)"\s*$/.exec(line);
    if (bullet) {
      ids.push(bullet[1]);
      continue;
    }
    if (line.trim() === '') {
      if (ids.length) {
        break;
      }
      continue;
    }
    // A description line between the key and its bullets is fine; anything
    // else after the first bullet ends the list.
    if (ids.length) {
      break;
    }
  }
  return ids;
}

/** A Claude id taken apart: `claude-opus-4.8-fast` → opus, [4, 8], `fast`. */
export interface ClaudeModelId {
  family: string;
  version: number[];
  /** Whatever follows the version: `fast`, `latest`, or empty. */
  suffix: string;
}

const DATE_PART = /^\d{8}$/;

/**
 * Parse either CLI's form of a Claude id. Undefined for anything that is not
 * `claude-…` with a recognisable family, so it is passed through untouched.
 *
 * Handled: `claude-fable-5.1`, `claude-fable-5-1`, `claude-opus-4.8-fast`,
 * `claude-sonnet-4-5-20250929` (the date dropped), `claude-3-5-sonnet-latest`
 * (the old version-first form).
 */
export function parseClaudeModelId(id: string): ClaudeModelId | undefined {
  const lower = id.trim().toLowerCase();
  if (!lower.startsWith('claude-')) {
    return undefined;
  }
  const parts = lower
    .slice('claude-'.length)
    .split(/[-.]/)
    .filter((part) => part.length > 0);
  if (!parts.length) {
    return undefined;
  }
  let family: string | undefined;
  const version: number[] = [];
  const rest: string[] = [];
  for (const part of parts) {
    if (family === undefined) {
      if (/^\d+$/.test(part)) {
        // The old form puts the version before the family.
        version.push(Number(part));
      } else {
        family = part;
      }
      continue;
    }
    if (/^\d+$/.test(part) && rest.length === 0) {
      if (DATE_PART.test(part)) {
        continue;
      }
      version.push(Number(part));
      continue;
    }
    rest.push(part);
  }
  if (family === undefined || !/^[a-z]+$/.test(family)) {
    return undefined;
  }
  return { family, version, suffix: rest.join('-') };
}

/** The Copilot form of a parsed id: `claude-<family>-<v.v>[-suffix]`. */
export function formatCopilotModelId(parsed: ClaudeModelId): string {
  const version = parsed.version.length ? `-${parsed.version.join('.')}` : '';
  const suffix = parsed.suffix ? `-${parsed.suffix}` : '';
  return `claude-${parsed.family}${version}${suffix}`;
}

function compareVersions(a: number[], b: number[]): number {
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i++) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    if (left !== right) {
      return left - right;
    }
  }
  return 0;
}

/**
 * The newest plain model of a family in the catalog — the highest version
 * with no suffix, so `claude-opus-4.8-fast` never wins over `claude-opus-4.8`
 * and an alias means the same thing it means to Claude Code.
 */
export function newestCopilotModel(
  family: string,
  catalog: readonly string[],
): string | undefined {
  let best: { id: string; parsed: ClaudeModelId } | undefined;
  for (const id of catalog) {
    const parsed = parseClaudeModelId(id);
    if (!parsed || parsed.family !== family || parsed.suffix) {
      continue;
    }
    if (!best || compareVersions(parsed.version, best.parsed.version) > 0) {
      best = { id, parsed };
    }
  }
  return best?.id;
}

export interface CopilotModelChoice {
  /** What goes after `--model`. */
  id: string;
  /**
   * How the id was arrived at, for the log line: `alias` (the newest of the
   * family), `exact` (the setting's own id, in Copilot's form, is in the
   * catalog), `family` (the setting's id is not, so the newest of its family
   * stands in), `passthrough` (nothing to go on; the CLI will say).
   */
  how: 'alias' | 'exact' | 'family' | 'passthrough';
}

/**
 * The Copilot model for the Claude Code model setting.
 *
 * - An alias (`sonnet`) → the newest `claude-sonnet-*` in the catalog.
 * - A full id → its Copilot form when the catalog has it; else the newest of
 *   its family, so a pinned `claude-sonnet-4-5-20250929` still gets a Sonnet
 *   from a CLI that no longer lists 4.5.
 * - Anything else is passed through for the CLI to accept or refuse.
 */
export function copilotModelFor(
  claudeModel: string,
  catalog: readonly string[],
): CopilotModelChoice {
  const setting = claudeModel.trim().toLowerCase();
  if ((CLAUDE_FAMILIES as readonly string[]).includes(setting)) {
    const newest = newestCopilotModel(setting, catalog);
    return newest
      ? { id: newest, how: 'alias' }
      : { id: setting, how: 'passthrough' };
  }
  const parsed = parseClaudeModelId(setting);
  if (!parsed) {
    return { id: claudeModel.trim(), how: 'passthrough' };
  }
  const exact = formatCopilotModelId(parsed);
  if (catalog.includes(exact)) {
    return { id: exact, how: 'exact' };
  }
  const newest = newestCopilotModel(parsed.family, catalog);
  return newest
    ? { id: newest, how: 'family' }
    : { id: exact, how: 'passthrough' };
}
