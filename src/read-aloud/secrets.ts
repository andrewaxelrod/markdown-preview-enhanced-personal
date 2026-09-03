import * as vscode from 'vscode';

/**
 * The ElevenLabs API key (F7).
 *
 * Mirrors `src/ai-translator.ts:4-62`: the key lives only in VS Code
 * `SecretStorage`, never in settings, never in the log, never in the webview,
 * never in an export.
 */

export const ELEVENLABS_API_KEY_SECRET = 'mpe.elevenlabs.apiKey';

let cachedContext: vscode.ExtensionContext | undefined;

export function setReadAloudSecretsContext(
  context: vscode.ExtensionContext,
): void {
  cachedContext = context;
}

function requireContext(): vscode.ExtensionContext {
  if (!cachedContext) {
    throw new Error('Read aloud secrets context not initialized');
  }
  return cachedContext;
}

export async function getElevenLabsApiKey(): Promise<string | undefined> {
  const key = await requireContext().secrets.get(ELEVENLABS_API_KEY_SECRET);
  return key && key.length > 0 ? key : undefined;
}

export async function storeElevenLabsApiKey(key: string): Promise<void> {
  await requireContext().secrets.store(ELEVENLABS_API_KEY_SECRET, key.trim());
}

export async function clearElevenLabsApiKey(): Promise<void> {
  await requireContext().secrets.delete(ELEVENLABS_API_KEY_SECRET);
}

/**
 * Masked prompt for the key. Returns the trimmed value, or `undefined` when
 * the user cancelled or entered nothing. Deliberately does **not** store: the
 * caller validates the key first (F7) and keeps the previous one on failure.
 */
export async function promptForElevenLabsApiKey(): Promise<string | undefined> {
  const entered = await vscode.window.showInputBox({
    prompt: 'Enter your ElevenLabs API key',
    password: true,
    ignoreFocusOut: true,
  });
  if (!entered) {
    return undefined;
  }
  const trimmed = entered.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
