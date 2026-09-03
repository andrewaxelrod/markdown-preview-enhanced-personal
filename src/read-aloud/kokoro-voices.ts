import * as vscode from 'vscode';
import { describeKokoroVoice, type KokoroClient } from './kokoro-client';
import { readAloudLog } from './log';
import { writeKokoroVoiceSetting } from './settings';

/**
 * The `Choose Read Aloud Voice` QuickPick when the provider is Kokoro (F8).
 *
 * Kokoro voices are plain ids (`af_heart`, `bm_george`, …) served by
 * `GET /v1/audio/voices`; the pick is written to
 * `markdown-preview-enhanced.kokoroVoice`. Blends such as `af_bella+af_sky`
 * can be typed into the setting directly.
 */
export async function chooseKokoroVoiceQuickPick(
  client: KokoroClient,
): Promise<string | undefined> {
  const { voices } = await client.listVoices();
  if (voices.length === 0) {
    void vscode.window.showWarningMessage(
      `The Kokoro server at ${client.url} reports no voices.`,
    );
    return undefined;
  }
  const items: Array<vscode.QuickPickItem & { voiceId: string }> = voices.map(
    (voice) => ({
      label: voice.id,
      description: voice.grade ? `grade ${voice.grade}` : undefined,
      detail: describeKokoroVoice(voice.id) || undefined,
      voiceId: voice.id,
    }),
  );
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: 'Select the Kokoro voice used for read aloud',
    matchOnDescription: true,
    matchOnDetail: true,
    ignoreFocusOut: true,
  });
  if (!picked) {
    return undefined;
  }
  await writeKokoroVoiceSetting(picked.voiceId);
  readAloudLog(`kokoro voice chosen id=${picked.voiceId}`);
  return picked.voiceId;
}
