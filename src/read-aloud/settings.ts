import type * as vscode from 'vscode';
import * as packageJSON from '../../package.json';
import { getMPEConfig, updateMPEConfig } from '../config';
import { DEFAULT_BASE_URL } from './elevenlabs-client';
import {
  DEFAULT_KOKORO_BASE_URL,
  DEFAULT_KOKORO_VOICE,
  isAllowedKokoroBaseUrl,
} from './kokoro-client';
import { readAloudLog } from './log';
import {
  clampSpeed,
  normaliseHighlightTheme,
  type ReadAloudHighlightTheme,
} from './messages';
import { DEFAULT_MODEL_ID, MODEL_IDS } from './models';

/**
 * Typed accessors for the twelve `markdown-preview-enhanced.readAloud*` /
 * `elevenLabs*` / `kokoro*` settings (spec §4.1, decision (e);
 * `readAloudHighlightTheme` was added with the ElevenLabs Reader look,
 * `readAloudClickToRead` with click to read (F17), and `readAloudProvider`,
 * `kokoroVoice`, `kokoroBaseUrl` with the local Kokoro provider).
 *
 * They are ordinary VS Code settings read through `getMPEConfig`, deliberately
 * not part of crossnote's `NotebookConfig`: they do not affect rendering, and
 * keeping them out avoids `updateAllNotebooksConfig` churn (B4).
 */

export const READ_ALOUD_SETTING_KEYS = [
  'readAloudEnabled',
  'readAloudClickToRead',
  'readAloudProvider',
  'elevenLabsVoiceId',
  'elevenLabsModelId',
  'kokoroVoice',
  'readAloudSpeed',
  'readAloudHighlightTheme',
  'readAloudConfirmAbove',
  'readAloudCacheSizeMB',
  'elevenLabsBaseUrl',
  'kokoroBaseUrl',
] as const;

export type ReadAloudSettingKey = (typeof READ_ALOUD_SETTING_KEYS)[number];

export const READ_ALOUD_PROVIDERS = ['kokoro', 'elevenlabs'] as const;
export type ReadAloudProvider = (typeof READ_ALOUD_PROVIDERS)[number];

/** Local, free and offline; ElevenLabs stays one setting away. */
export const DEFAULT_READ_ALOUD_PROVIDER: ReadAloudProvider = 'kokoro';

export interface ReadAloudSettings {
  enabled: boolean;
  clickToRead: boolean;
  provider: ReadAloudProvider;
  voiceId: string;
  modelId: string;
  kokoroVoice: string;
  speed: number;
  highlightTheme: ReadAloudHighlightTheme;
  confirmAbove: number;
  cacheSizeMB: number;
  baseUrl: string;
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

export function normaliseProvider(value: unknown): ReadAloudProvider {
  return typeof value === 'string' &&
    (READ_ALOUD_PROVIDERS as readonly string[]).includes(value)
    ? (value as ReadAloudProvider)
    : DEFAULT_READ_ALOUD_PROVIDER;
}

/** All settings, normalised. Never throws; every value is range-checked. */
export function readReadAloudSettings(): ReadAloudSettings {
  const enabledRaw = getMPEConfig<boolean>('readAloudEnabled');
  const clickToReadRaw = getMPEConfig<boolean>('readAloudClickToRead');
  const providerRaw = getMPEConfig<string>('readAloudProvider');
  const voiceRaw = getMPEConfig<string>('elevenLabsVoiceId');
  const modelRaw = getMPEConfig<string>('elevenLabsModelId');
  const kokoroVoiceRaw = getMPEConfig<string>('kokoroVoice');
  const speedRaw = getMPEConfig<number>('readAloudSpeed');
  const themeRaw = getMPEConfig<string>('readAloudHighlightTheme');
  const baseUrlRaw = getMPEConfig<string>('elevenLabsBaseUrl');
  const kokoroBaseUrlRaw = getMPEConfig<string>('kokoroBaseUrl');

  const modelId =
    typeof modelRaw === 'string' &&
    (MODEL_IDS as readonly string[]).includes(modelRaw)
      ? modelRaw
      : DEFAULT_MODEL_ID;

  let baseUrl = DEFAULT_BASE_URL;
  if (typeof baseUrlRaw === 'string' && baseUrlRaw.trim().length > 0) {
    const trimmed = baseUrlRaw.trim().replace(/\/+$/, '');
    if (trimmed.startsWith('https://')) {
      baseUrl = trimmed;
    } else {
      readAloudLog(
        `ignoring elevenLabsBaseUrl (not https): using ${DEFAULT_BASE_URL} instead`,
      );
    }
  }

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
    provider: normaliseProvider(providerRaw),
    voiceId: typeof voiceRaw === 'string' ? voiceRaw.trim() : '',
    modelId,
    kokoroVoice,
    speed: clampSpeed(typeof speedRaw === 'number' ? speedRaw : 1),
    highlightTheme: normaliseHighlightTheme(themeRaw),
    confirmAbove: readInteger('readAloudConfirmAbove', 5000, 0),
    cacheSizeMB: readInteger('readAloudCacheSizeMB', 100, 1),
    baseUrl,
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

export async function writeVoiceIdSetting(voiceId: string): Promise<void> {
  await updateMPEConfig('elevenLabsVoiceId', voiceId, true);
}

export async function writeModelIdSetting(modelId: string): Promise<void> {
  await updateMPEConfig('elevenLabsModelId', modelId, true);
}

export async function writeKokoroVoiceSetting(voiceId: string): Promise<void> {
  await updateMPEConfig('kokoroVoice', voiceId, true);
}

export async function writeSpeedSetting(rate: number): Promise<void> {
  await updateMPEConfig('readAloudSpeed', rate, true);
}
