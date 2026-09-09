import * as os from 'os';
import * as path from 'path';
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
  clampTextSize,
  clampVolume,
  HELP_CONTEXT_MODES,
  normaliseGlobalTheme,
  normaliseHighlightTheme,
  normaliseNotesDecoration,
  normalisePlayerFont,
  normaliseWordMarker,
  type HelpContextMode,
  type NotesDecoration,
  type ReadAloudFont,
  type ReadAloudGlobalTheme,
  type ReadAloudHighlightTheme,
  type ReadAloudWordMarker,
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
  // The low-strain page (`featrues/05-eye-strain.spec.md` §10.1). Live, like
  // the rest: a change never reloads the preview.
  'readAloudGlobalTheme',
  // Eye strain 2 (`featrues/07-eye-strain-2/spec.md` §15.1): the text size,
  // the word marker, dimming and the panel's auto-hide. Live as well.
  'readAloudTextSize',
  'readAloudWordMarker',
  'readAloudDimWhileReading',
  'readAloudPanelAutoHide',
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
  // Notes (`featrues/12-notes/spec.md` §14.1). `notesEnabled` and
  // `notesDecoration` ride in `readAloudConfig`; the root and the generate
  // switch are read per operation.
  'notesEnabled',
  'notesDirectory',
  'notesGenerate',
  'notesDecoration',
  // Classroom (`featrues/13-classroom/spec.md` §14.1). `classroomEnabled`
  // rides in `readAloudConfig`; the others are read per Prepare or Build.
  'classroomEnabled',
  'classroomDirectory',
  'classroomPersona',
  'classroomAudience',
  'classroomFollowLinks',
  'classroomAutoOpen',
  // 13 §6.1 and §12.5: the term budgets and the module marker.
  'classroomShortTermModules',
  'classroomMarker',
  // Retell (`featrues/15-convert-readable/spec.md` §14.1). `retellEnabled`
  // and `retellMarker` ride in `readAloudConfig`; the other two are read per
  // Prepare or Build.
  'retellEnabled',
  'retellDirectory',
  'retellAutoOpen',
  'retellMarker',
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

/** §14.1 — the four notes settings. */
export interface ReadAloudNotesSettings {
  enabled: boolean;
  /** The root, `~` expanded; '' means `<globalConfigPath>/notes` (§7.1). */
  directory: string;
  generate: boolean;
  decoration: NotesDecoration;
}

/** 13 §14.1 — the eight classroom settings. */
export interface ReadAloudClassroomSettings {
  enabled: boolean;
  /** The root, `~` expanded; '' means `<globalConfigPath>/classroom` (§11.1). */
  directory: string;
  /** The persona id in force; validated against the id pattern. */
  persona: string;
  /** The audience line; '' means the persona's default. */
  audience: string;
  followLinks: boolean;
  autoOpen: boolean;
  /** 13 §6.1 — a term-shaped passage takes the smaller budgets. */
  shortTerm: boolean;
  /** 13 §12.5 — the module marker in the source document. */
  marker: boolean;
}

/** 15 §14.1 — the four retell settings. */
export interface ReadAloudRetellSettings {
  enabled: boolean;
  /** The root, `~` expanded; '' means `<globalConfigPath>/retell` (§11.1). */
  directory: string;
  autoOpen: boolean;
  /** 15 §12.5 — the ear marker in the source document. */
  marker: boolean;
}

export const CLASSROOM_PERSONA_SETTING_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const DEFAULT_CLASSROOM_PERSONA = 'max';

export interface ReadAloudSettings {
  enabled: boolean;
  clickToRead: boolean;
  kokoroVoice: string;
  speed: number;
  volume: number;
  highlightTheme: ReadAloudHighlightTheme;
  font: ReadAloudFont;
  globalTheme: ReadAloudGlobalTheme;
  textSize: number;
  wordMarker: ReadAloudWordMarker;
  dimWhileReading: boolean;
  panelAutoHide: boolean;
  cacheSizeMB: number;
  kokoroBaseUrl: string;
  help: ReadAloudHelpSettings;
  notes: ReadAloudNotesSettings;
  classroom: ReadAloudClassroomSettings;
  retell: ReadAloudRetellSettings;
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

/**
 * §14.1 — the notes settings. `notesDirectory` is machine scope for the
 * reason `kokoroBaseUrl` is: a workspace's `.vscode/settings.json` must not
 * be able to redirect where document text is written. A relative path is
 * ignored (the root must be absolute once `~` is expanded).
 */
export function readNotesSettings(): ReadAloudNotesSettings {
  const enabledRaw = getMPEConfig<boolean>('notesEnabled');
  const generateRaw = getMPEConfig<boolean>('notesGenerate');
  const directoryRaw = getMPEConfig<string>('notesDirectory');
  let directory = '';
  if (typeof directoryRaw === 'string' && directoryRaw.trim()) {
    const expanded = directoryRaw.trim().replace(/^~(?=$|[\\/])/, os.homedir());
    if (path.isAbsolute(expanded)) {
      directory = expanded;
    } else {
      readAloudLog(
        `ignoring notesDirectory ${JSON.stringify(directoryRaw)}: not an absolute path; using the default root`,
      );
    }
  }
  return {
    enabled: typeof enabledRaw === 'boolean' ? enabledRaw : true,
    directory,
    generate: typeof generateRaw === 'boolean' ? generateRaw : true,
    decoration: normaliseNotesDecoration(
      getMPEConfig<string>('notesDecoration'),
    ),
  };
}

/**
 * 13 §14.1 — the classroom settings. `classroomDirectory` is machine scope
 * for the reason `notesDirectory` is; a relative path is ignored.
 */
export function readClassroomSettings(): ReadAloudClassroomSettings {
  const enabledRaw = getMPEConfig<boolean>('classroomEnabled');
  const directoryRaw = getMPEConfig<string>('classroomDirectory');
  const personaRaw = getMPEConfig<string>('classroomPersona');
  const audienceRaw = getMPEConfig<string>('classroomAudience');
  const followRaw = getMPEConfig<boolean>('classroomFollowLinks');
  const autoOpenRaw = getMPEConfig<boolean>('classroomAutoOpen');
  const shortTermRaw = getMPEConfig<boolean>('classroomShortTermModules');
  const markerRaw = getMPEConfig<boolean>('classroomMarker');
  let directory = '';
  if (typeof directoryRaw === 'string' && directoryRaw.trim()) {
    const expanded = directoryRaw.trim().replace(/^~(?=$|[\\/])/, os.homedir());
    if (path.isAbsolute(expanded)) {
      directory = expanded;
    } else {
      readAloudLog(
        `ignoring classroomDirectory ${JSON.stringify(directoryRaw)}: not an absolute path; using the default root`,
      );
    }
  }
  let persona = DEFAULT_CLASSROOM_PERSONA;
  if (typeof personaRaw === 'string' && personaRaw.trim()) {
    const trimmed = personaRaw.trim();
    if (CLASSROOM_PERSONA_SETTING_RE.test(trimmed)) {
      persona = trimmed;
    } else {
      readAloudLog(
        `ignoring classroomPersona ${JSON.stringify(trimmed)}: not a persona id; using ${DEFAULT_CLASSROOM_PERSONA}`,
      );
    }
  }
  return {
    enabled: typeof enabledRaw === 'boolean' ? enabledRaw : true,
    directory,
    persona,
    audience:
      typeof audienceRaw === 'string'
        ? audienceRaw.replace(/\s+/g, ' ').trim().slice(0, 300)
        : '',
    followLinks: typeof followRaw === 'boolean' ? followRaw : true,
    autoOpen: typeof autoOpenRaw === 'boolean' ? autoOpenRaw : true,
    shortTerm: typeof shortTermRaw === 'boolean' ? shortTermRaw : true,
    marker: typeof markerRaw === 'boolean' ? markerRaw : true,
  };
}

/**
 * 15 §14.1 — the retell settings. `retellDirectory` is machine scope for the
 * reason `notesDirectory` is; a relative path is ignored.
 */
export function readRetellSettings(): ReadAloudRetellSettings {
  const enabledRaw = getMPEConfig<boolean>('retellEnabled');
  const directoryRaw = getMPEConfig<string>('retellDirectory');
  const autoOpenRaw = getMPEConfig<boolean>('retellAutoOpen');
  const markerRaw = getMPEConfig<boolean>('retellMarker');
  let directory = '';
  if (typeof directoryRaw === 'string' && directoryRaw.trim()) {
    const expanded = directoryRaw.trim().replace(/^~(?=$|[\\/])/, os.homedir());
    if (path.isAbsolute(expanded)) {
      directory = expanded;
    } else {
      readAloudLog(
        `ignoring retellDirectory ${JSON.stringify(directoryRaw)}: not an absolute path; using the default root`,
      );
    }
  }
  return {
    enabled: typeof enabledRaw === 'boolean' ? enabledRaw : true,
    directory,
    autoOpen: typeof autoOpenRaw === 'boolean' ? autoOpenRaw : true,
    marker: typeof markerRaw === 'boolean' ? markerRaw : true,
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
  const globalThemeRaw = getMPEConfig<string>('readAloudGlobalTheme');
  const textSizeRaw = getMPEConfig<number>('readAloudTextSize');
  const wordMarkerRaw = getMPEConfig<string>('readAloudWordMarker');
  const dimRaw = getMPEConfig<boolean>('readAloudDimWhileReading');
  const autoHideRaw = getMPEConfig<boolean>('readAloudPanelAutoHide');
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
    globalTheme: normaliseGlobalTheme(globalThemeRaw),
    // A hand-edited value outside the slider's range is clamped and rounded
    // to whole pixels (07 §5.1).
    textSize: clampTextSize(textSizeRaw),
    wordMarker: normaliseWordMarker(wordMarkerRaw),
    dimWhileReading: typeof dimRaw === 'boolean' ? dimRaw : true,
    panelAutoHide: typeof autoHideRaw === 'boolean' ? autoHideRaw : true,
    cacheSizeMB: readInteger('readAloudCacheSizeMB', 100, 1),
    kokoroBaseUrl,
    help: readHelpSettings(),
    notes: readNotesSettings(),
    classroom: readClassroomSettings(),
    retell: readRetellSettings(),
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

export async function writeGlobalThemeSetting(
  theme: ReadAloudGlobalTheme,
): Promise<void> {
  await updateMPEConfig('readAloudGlobalTheme', theme, true);
}

export async function writeTextSizeSetting(value: number): Promise<void> {
  await updateMPEConfig('readAloudTextSize', value, true);
}

export async function writeWordMarkerSetting(
  style: ReadAloudWordMarker,
): Promise<void> {
  await updateMPEConfig('readAloudWordMarker', style, true);
}

/**
 * 05 §9.4 — Reset page settings. The user values are *cleared*, not set to
 * the defaults, so a later change of a default in package.json is honoured
 * (D16). The highlight palette, speed, volume, dimming and auto-hide are
 * player preferences and are left alone (07 §14).
 */
export async function clearPageSettings(): Promise<void> {
  await updateMPEConfig('readAloudGlobalTheme', undefined, true);
  await updateMPEConfig('readAloudTextSize', undefined, true);
  await updateMPEConfig('readAloudFont', undefined, true);
  await updateMPEConfig('readAloudWordMarker', undefined, true);
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

/** 13 §5.4 step 2 — Build writes the instructor and the audience it used. */
export async function writeClassroomPersonaSetting(id: string): Promise<void> {
  await updateMPEConfig('classroomPersona', id, true);
}

export async function writeClassroomAudienceSetting(
  audience: string,
): Promise<void> {
  await updateMPEConfig('classroomAudience', audience, true);
}
