import type * as vscode from 'vscode';
import * as packageJSON from '../../package.json';
import { getMPEConfig, updateMPEConfig } from '../config';
import {
  DEFAULT_KOKORO_BASE_URL,
  DEFAULT_KOKORO_VOICE,
  isAllowedKokoroBaseUrl,
} from './kokoro-client';
import { readAloudLog } from './log';
import {
  clampSpeed,
  clampVolume,
  normaliseHighlightTheme,
  normalisePlayerFont,
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
] as const;

export type ReadAloudSettingKey = (typeof READ_ALOUD_SETTING_KEYS)[number];

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
