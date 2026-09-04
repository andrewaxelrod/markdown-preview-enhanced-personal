import type * as vscode from 'vscode';
import * as packageJSON from '../../package.json';
import { getMPEConfig, updateMPEConfig } from '../config';
import {
  DEFAULT_KOKORO_BASE_URL,
  DEFAULT_KOKORO_VOICE,
  isAllowedKokoroBaseUrl,
} from './kokoro-client';
import {
  CLAUDE_EFFORTS,
  CODEX_EFFORTS,
  CLAUDE_MODEL_RE,
  clampHelpTimeout,
  DEFAULT_CLAUDE_EFFORT,
  DEFAULT_CLAUDE_MODEL,
  DEFAULT_CODEX_EFFORT,
  DEFAULT_HELP_ENGINE,
  HELP_ENGINES,
  type ClaudeEffort,
  type CodexEffort,
  type HelpEngineId,
} from './help-engine';
import { DEFAULT_HELP_AUDIENCE } from './help-prompt';
import { readAloudLog } from './log';
import {
  clampSpeed,
  clampVolume,
  HELP_CONTEXT_MODES,
  normaliseHighlightTheme,
  normalisePlayerFont,
  type HelpContextMode,
  type ReadAloudFont,
  type ReadAloudHighlightTheme,
} from './messages';

/**
 * Typed accessors for the nine `markdown-preview-enhanced.readAloud*` /
 * `kokoro*` settings (spec §4.1).
 *
 * They are ordinary VS Code settings read through `getMPEConfig`, deliberately
 * not part of crossnote's `NotebookConfig`: they do not affect rendering, and
 * keeping them out avoids `updateAllNotebooksConfig` churn (B4).
 */

export const READ_ALOUD_SETTING_KEYS = [
  'readAloudEnabled',
  'readAloudClickToRead',
  'kokoroVoice',
  'readAloudSpeed',
  'readAloudVolume',
  'readAloudHighlightTheme',
  'readAloudFont',
  'readAloudCacheSizeMB',
  'kokoroBaseUrl',
  // Help (`featrues/04-help-module.md` §7.1). Read per request, so a change
  // takes effect on the next question with no reload.
  'readAloudHelpEngine',
  'readAloudHelpClaudeModel',
  'readAloudHelpClaudeEffort',
  'readAloudHelpCodexModel',
  'readAloudHelpCodexEffort',
  'readAloudHelpCommand',
  'readAloudHelpContext',
  'readAloudHelpAudience',
  'readAloudHelpAutoPlay',
  'readAloudHelpTimeoutSeconds',
  'readAloudHelpBinaryPath',
] as const;

export type ReadAloudSettingKey = (typeof READ_ALOUD_SETTING_KEYS)[number];

/** The subset the sheet's label and its auto-play follow (§4 step 2, D2). */
export const HELP_SETTING_KEYS: ReadAloudSettingKey[] = [
  'readAloudHelpEngine',
  'readAloudHelpClaudeModel',
  'readAloudHelpClaudeEffort',
  'readAloudHelpCodexModel',
  'readAloudHelpCodexEffort',
  'readAloudHelpCommand',
  'readAloudHelpAutoPlay',
];

export interface ReadAloudHelpSettings {
  engine: HelpEngineId;
  claudeModel: string;
  claudeEffort: ClaudeEffort;
  codexModel: string;
  codexEffort: CodexEffort;
  command: string[];
  contextMode: HelpContextMode;
  audience: string;
  autoPlay: boolean;
  timeoutSeconds: number;
  binaryPath: { claude?: string; codex?: string };
}

export interface ReadAloudSettings {
  enabled: boolean;
  clickToRead: boolean;
  kokoroVoice: string;
  speed: number;
  volume: number;
  highlightTheme: ReadAloudHighlightTheme;
  font: ReadAloudFont;
  cacheSizeMB: number;
  kokoroBaseUrl: string;
  help: ReadAloudHelpSettings;
}

const SETTINGS_NAMESPACE = 'markdown-preview-enhanced';

function qualified(key: ReadAloudSettingKey): string {
  return `${SETTINGS_NAMESPACE}.${key}`;
}

function readInteger(
  key: ReadAloudSettingKey,
  fallback: number,
  min: number,
): number {
  const raw = getMPEConfig<number>(key);
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return fallback;
  }
  return Math.max(min, Math.floor(raw));
}

function readEnum<T extends string>(
  key: ReadAloudSettingKey,
  allowed: readonly T[],
  fallback: T,
): T {
  const raw = getMPEConfig<string>(key);
  return typeof raw === 'string' && (allowed as readonly string[]).includes(raw)
    ? (raw as T)
    : fallback;
}

/**
 * §7.1 — the help settings.
 *
 * Every value is range-checked here rather than trusted from the settings
 * file: `readAloudHelpCommand` becomes an argv only when the engine is
 * `custom`, and `readAloudHelpBinaryPath` accepts absolute paths only, so a
 * workspace's `.vscode/settings.json` cannot quietly route the document's text
 * to another binary (§10).
 */
export function readHelpSettings(): ReadAloudHelpSettings {
  const engine = readEnum<HelpEngineId>(
    'readAloudHelpEngine',
    HELP_ENGINES,
    DEFAULT_HELP_ENGINE,
  );

  const claudeModelRaw = getMPEConfig<string>('readAloudHelpClaudeModel');
  let claudeModel = DEFAULT_CLAUDE_MODEL;
  if (typeof claudeModelRaw === 'string' && claudeModelRaw.trim()) {
    const trimmed = claudeModelRaw.trim();
    if (CLAUDE_MODEL_RE.test(trimmed)) {
      claudeModel = trimmed;
    } else {
      readAloudLog(
        `ignoring readAloudHelpClaudeModel ${JSON.stringify(trimmed)}: using ${DEFAULT_CLAUDE_MODEL} instead`,
      );
    }
  }

  const codexModelRaw = getMPEConfig<string>('readAloudHelpCodexModel');
  // An empty codex model omits `-m` and lets the CLI's own default answer.
  const codexModel =
    typeof codexModelRaw === 'string' ? codexModelRaw.trim().slice(0, 200) : '';

  const commandRaw = getMPEConfig<string[]>('readAloudHelpCommand');
  const command: string[] = [];
  if (Array.isArray(commandRaw)) {
    for (const part of commandRaw) {
      if (typeof part === 'string') {
        command.push(part);
      }
    }
  }

  const audienceRaw = getMPEConfig<string>('readAloudHelpAudience');
  const audience =
    typeof audienceRaw === 'string' && audienceRaw.trim()
      ? audienceRaw.trim().slice(0, 300)
      : DEFAULT_HELP_AUDIENCE;

  const autoPlayRaw = getMPEConfig<boolean>('readAloudHelpAutoPlay');
  const timeoutRaw = getMPEConfig<number>('readAloudHelpTimeoutSeconds');

  const binaryRaw = getMPEConfig<Record<string, unknown>>(
    'readAloudHelpBinaryPath',
  );
  const binaryPath: { claude?: string; codex?: string } = {};
  if (binaryRaw && typeof binaryRaw === 'object') {
    for (const name of ['claude', 'codex'] as const) {
      const value = (binaryRaw as Record<string, unknown>)[name];
      if (typeof value === 'string' && value.trim()) {
        binaryPath[name] = value.trim();
      }
    }
  }

  return {
    engine,
    claudeModel,
    claudeEffort: readEnum<ClaudeEffort>(
      'readAloudHelpClaudeEffort',
      CLAUDE_EFFORTS,
      DEFAULT_CLAUDE_EFFORT,
    ),
    codexModel,
    codexEffort: readEnum<CodexEffort>(
      'readAloudHelpCodexEffort',
      CODEX_EFFORTS,
      DEFAULT_CODEX_EFFORT,
    ),
    command,
    contextMode: readEnum<HelpContextMode>(
      'readAloudHelpContext',
      HELP_CONTEXT_MODES,
      'section',
    ),
    audience,
    autoPlay: typeof autoPlayRaw === 'boolean' ? autoPlayRaw : true,
    timeoutSeconds: clampHelpTimeout(timeoutRaw),
    binaryPath,
  };
}

/** All settings, normalised. Never throws; every value is range-checked. */
export function readReadAloudSettings(): ReadAloudSettings {
  const enabledRaw = getMPEConfig<boolean>('readAloudEnabled');
  const clickToReadRaw = getMPEConfig<boolean>('readAloudClickToRead');
  const kokoroVoiceRaw = getMPEConfig<string>('kokoroVoice');
  const speedRaw = getMPEConfig<number>('readAloudSpeed');
  const volumeRaw = getMPEConfig<number>('readAloudVolume');
  const themeRaw = getMPEConfig<string>('readAloudHighlightTheme');
  const fontRaw = getMPEConfig<string>('readAloudFont');
  const kokoroBaseUrlRaw = getMPEConfig<string>('kokoroBaseUrl');

  let kokoroBaseUrl = DEFAULT_KOKORO_BASE_URL;
  if (
    typeof kokoroBaseUrlRaw === 'string' &&
    kokoroBaseUrlRaw.trim().length > 0
  ) {
    const trimmed = kokoroBaseUrlRaw.trim().replace(/\/+$/, '');
    if (isAllowedKokoroBaseUrl(trimmed)) {
      kokoroBaseUrl = trimmed;
    } else {
      readAloudLog(
        `ignoring kokoroBaseUrl (must be https, or http on localhost): using ${DEFAULT_KOKORO_BASE_URL} instead`,
      );
    }
  }

  const kokoroVoice =
    typeof kokoroVoiceRaw === 'string' && kokoroVoiceRaw.trim().length > 0
      ? kokoroVoiceRaw.trim()
      : DEFAULT_KOKORO_VOICE;

  return {
    enabled: typeof enabledRaw === 'boolean' ? enabledRaw : true,
    clickToRead: typeof clickToReadRaw === 'boolean' ? clickToReadRaw : true,
    kokoroVoice,
    speed: clampSpeed(typeof speedRaw === 'number' ? speedRaw : 1),
    volume: clampVolume(typeof volumeRaw === 'number' ? volumeRaw : 1),
    highlightTheme: normaliseHighlightTheme(themeRaw),
    font: normalisePlayerFont(fontRaw),
    cacheSizeMB: readInteger('readAloudCacheSizeMB', 100, 1),
    kokoroBaseUrl,
    help: readHelpSettings(),
  };
}

/** Which read-aloud settings a configuration change touched. */
export function readAloudSettingsAffected(
  event: vscode.ConfigurationChangeEvent,
): ReadAloudSettingKey[] {
  return READ_ALOUD_SETTING_KEYS.filter((key) =>
    event.affectsConfiguration(qualified(key)),
  );
}

/**
 * Whether the change touched any *other* `markdown-preview-enhanced` setting.
 * Lane C uses this to skip `updateAllNotebooksConfig()` — and therefore the
 * full preview reload — when only read-aloud keys changed (B4).
 */
export function otherMpeSettingsAffected(
  event: vscode.ConfigurationChangeEvent,
): boolean {
  const readAloudKeys = new Set<string>(READ_ALOUD_SETTING_KEYS.map(qualified));
  const properties = packageJSON.contributes.configuration.properties as Record<
    string,
    unknown
  >;
  for (const key of Object.keys(properties)) {
    if (!readAloudKeys.has(key) && event.affectsConfiguration(key)) {
      return true;
    }
  }
  return false;
}

export async function writeKokoroVoiceSetting(voiceId: string): Promise<void> {
  await updateMPEConfig('kokoroVoice', voiceId, true);
}

export async function writeSpeedSetting(rate: number): Promise<void> {
  await updateMPEConfig('readAloudSpeed', rate, true);
}

export async function writeVolumeSetting(level: number): Promise<void> {
  await updateMPEConfig('readAloudVolume', level, true);
}

export async function writeHighlightThemeSetting(
  theme: ReadAloudHighlightTheme,
): Promise<void> {
  await updateMPEConfig('readAloudHighlightTheme', theme, true);
}

export async function writeFontSetting(font: ReadAloudFont): Promise<void> {
  await updateMPEConfig('readAloudFont', font, true);
}

/** §7.1 — what the _Choose Help Model_ quick pick writes, per engine. */
export async function writeHelpModelSettings(
  engine: HelpEngineId,
  model: string,
  effort: string,
): Promise<void> {
  if (engine === 'claude') {
    await updateMPEConfig('readAloudHelpClaudeModel', model, true);
    await updateMPEConfig('readAloudHelpClaudeEffort', effort, true);
    return;
  }
  if (engine === 'codex') {
    await updateMPEConfig('readAloudHelpCodexModel', model, true);
    await updateMPEConfig('readAloudHelpCodexEffort', effort, true);
  }
}
