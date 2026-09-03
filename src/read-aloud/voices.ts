import * as vscode from 'vscode';
import {
  ElevenLabsHttpError,
  type ElevenLabsClient,
} from './elevenlabs-client';
import { readAloudLog } from './log';
import { writeVoiceIdSetting } from './settings';

/**
 * Default voice resolution and the voice picker (F8, R2 §7.2, §7.3).
 *
 * No voice ID is hard-coded anywhere: the docs' example voices are being
 * retired and are unavailable to accounts created after March 2026 (R2 §7.1),
 * so the first voice the account actually has is resolved at runtime and
 * written to the `elevenLabsVoiceId` setting.
 */

export interface ResolvedVoice {
  voiceId: string;
  name: string;
}

/** `context.globalState`: `Record<voiceId, name>`. */
export const VOICE_NAMES_STATE_KEY = 'mpe.readAloud.voiceNames';

/** `context.globalState`: `Record<voiceId, true>` — the F8 one-time notice. */
export const VOICE_NOTICE_STATE_KEY = 'mpe.readAloud.voiceNoticeShown';

const CHANGE_VOICE_ACTION = 'Change voice…';

/** F8 — the QuickPick pages until `has_more` is false, at most this many pages. */
const MAX_VOICE_PAGES = 5;
const VOICE_PAGE_SIZE = 100;

let cachedContext: vscode.ExtensionContext | undefined;
const voiceNames = new Map<string, string>();

export function setVoicesContext(context: vscode.ExtensionContext): void {
  cachedContext = context;
  const stored = context.globalState.get<Record<string, string>>(
    VOICE_NAMES_STATE_KEY,
  );
  if (stored) {
    for (const [voiceId, name] of Object.entries(stored)) {
      if (typeof name === 'string') {
        voiceNames.set(voiceId, name);
      }
    }
  }
}

export function getCachedVoiceName(voiceId: string): string | undefined {
  return voiceNames.get(voiceId);
}

export async function cacheVoiceName(voice: ResolvedVoice): Promise<void> {
  voiceNames.set(voice.voiceId, voice.name);
  if (!cachedContext) {
    return;
  }
  const stored = {
    ...(cachedContext.globalState.get<Record<string, string>>(
      VOICE_NAMES_STATE_KEY,
    ) ?? {}),
    [voice.voiceId]: voice.name,
  };
  await cachedContext.globalState.update(VOICE_NAMES_STATE_KEY, stored);
}

async function noticeAlreadyShown(voiceId: string): Promise<boolean> {
  if (!cachedContext) {
    return true;
  }
  const shown =
    cachedContext.globalState.get<Record<string, boolean>>(
      VOICE_NOTICE_STATE_KEY,
    ) ?? {};
  if (shown[voiceId] === true) {
    return true;
  }
  await cachedContext.globalState.update(VOICE_NOTICE_STATE_KEY, {
    ...shown,
    [voiceId]: true,
  });
  return false;
}

function voiceFrom(voiceId: string, name: string | undefined): ResolvedVoice {
  return { voiceId, name: name && name.length > 0 ? name : voiceId };
}

/**
 * `GET /v2/voices?page_size=1` -> `voices[0]`, written to the setting, with the
 * F8 one-time "Reading with voice <name>" notice.
 *
 * Returns `undefined` only when the account genuinely has no voices. HTTP and
 * network errors propagate unchanged (G-13): a revoked key or an offline
 * machine must never be reported as "No ElevenLabs voice…".
 */
export async function resolveDefaultVoice(
  client: ElevenLabsClient,
  signal?: AbortSignal,
): Promise<ResolvedVoice | undefined> {
  const page = await client.listVoices(1, undefined, signal);
  const first = page.voices[0];
  if (
    !first ||
    typeof first.voice_id !== 'string' ||
    first.voice_id.length === 0
  ) {
    void vscode.window.showWarningMessage(
      'No ElevenLabs voice is available on this account.',
    );
    return undefined;
  }
  const voice = voiceFrom(first.voice_id, first.name);
  // Cache the name *before* writing the setting: the settings listener then
  // sees a known name and skips a redundant validation call (A-27).
  await cacheVoiceName(voice);
  await writeVoiceIdSetting(voice.voiceId);
  readAloudLog(
    `voice resolved id=${voice.voiceId} name=${JSON.stringify(voice.name)}`,
  );
  if (!(await noticeAlreadyShown(voice.voiceId))) {
    void vscode.window
      .showInformationMessage(
        `Reading with voice ${voice.name}`,
        CHANGE_VOICE_ACTION,
      )
      .then(
        (picked) => {
          if (picked === CHANGE_VOICE_ACTION) {
            void chooseVoiceQuickPick(client).then(
              undefined,
              (error: unknown) => {
                readAloudLog(`voice picker failed: ${String(error)}`);
              },
            );
          }
        },
        () => {
          // Notification failures are irrelevant to playback.
        },
      );
  }
  return voice;
}

/**
 * `GET /v1/voices/{id}`, caching the name for the player bar (F8).
 *
 * `undefined` means "this voice is gone" (404/403) and the caller re-resolves.
 * Every other HTTP error and any network error propagates (G-13).
 */
export async function validateVoice(
  client: ElevenLabsClient,
  voiceId: string,
  signal?: AbortSignal,
): Promise<ResolvedVoice | undefined> {
  try {
    const detail = await client.getVoice(voiceId, signal);
    const voice = voiceFrom(detail.voiceId, detail.name);
    await cacheVoiceName(voice);
    return voice;
  } catch (error) {
    if (
      error instanceof ElevenLabsHttpError &&
      (error.meta.status === 404 || error.meta.status === 403)
    ) {
      readAloudLog(
        `voice ${voiceId} unavailable (status ${error.meta.status})`,
      );
      return undefined;
    }
    throw error;
  }
}

/**
 * F8 — the `Choose Read Aloud Voice` QuickPick. Pages with `next_page_token`
 * until `has_more` is false or {@link MAX_VOICE_PAGES} pages have been read,
 * and writes the setting on pick.
 */
export async function chooseVoiceQuickPick(
  client: ElevenLabsClient,
): Promise<ResolvedVoice | undefined> {
  const items: Array<vscode.QuickPickItem & { voice: ResolvedVoice }> = [];
  let token: string | undefined;
  for (let page = 0; page < MAX_VOICE_PAGES; page++) {
    const result = await client.listVoices(VOICE_PAGE_SIZE, token);
    for (const wire of result.voices) {
      if (typeof wire.voice_id !== 'string' || wire.voice_id.length === 0) {
        continue;
      }
      const voice = voiceFrom(wire.voice_id, wire.name);
      items.push({
        label: voice.name,
        description: voice.voiceId,
        detail: wire.category,
        voice,
      });
    }
    if (!result.hasMore || !result.nextPageToken) {
      break;
    }
    token = result.nextPageToken;
  }

  if (items.length === 0) {
    void vscode.window.showWarningMessage(
      'No ElevenLabs voice is available on this account.',
    );
    return undefined;
  }

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: 'Select the ElevenLabs voice used for read aloud',
    matchOnDescription: true,
    matchOnDetail: true,
    ignoreFocusOut: true,
  });
  if (!picked) {
    return undefined;
  }
  await cacheVoiceName(picked.voice);
  await writeVoiceIdSetting(picked.voice.voiceId);
  readAloudLog(`voice chosen id=${picked.voice.voiceId}`);
  return picked.voice;
}
