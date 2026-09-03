import * as vscode from 'vscode';
import type { ResponseMeta } from './kokoro-client';

/**
 * The "MPE Read Aloud" diagnostic channel (F10, F14).
 *
 * Mirrors the "MPE AI Translation" channel in `src/ai-translator.ts`: the
 * Kokoro calls run in the Node extension host, so the webview's Network
 * panel never sees them.
 *
 * The channel never contains more than the first 80 characters of any text
 * sent for synthesis (F14).
 */

const CHANNEL_NAME = 'MPE Read Aloud';

/** How much of the text may appear in the log (F14). */
const REDACT_CHARS = 80;

let outputChannel: vscode.OutputChannel | undefined;

function channel(): vscode.OutputChannel {
  if (!outputChannel) {
    outputChannel = vscode.window.createOutputChannel(CHANNEL_NAME);
  }
  return outputChannel;
}

/** Append one timestamped line to the channel. */
export function readAloudLog(line: string): void {
  try {
    channel().appendLine(`[${new Date().toISOString()}] ${line}`);
  } catch {
    // Logging must never break playback.
  }
}

/** Reveal the channel (the `Show Read Aloud Log` command). */
export function showReadAloudLog(): void {
  channel().show(true);
}

/** Dispose the channel; called from `ReadAloudController.dispose()` (A-26). */
export function disposeReadAloudLog(): void {
  outputChannel?.dispose();
  outputChannel = undefined;
}

/**
 * The first 80 characters of `text`, JSON-escaped so control characters and
 * quotes cannot break the log line, followed by the full length (F14).
 */
export function redactText(text: string): string {
  const head = JSON.stringify(text.slice(0, REDACT_CHARS));
  return `${head.slice(1, head.length - 1)}… (${text.length} chars)`;
}

export interface RequestLogFields {
  kind: string;
  requestId: string;
  chunk: string;
  block: number;
  textLength: number;
  text: string;
  model: string;
  voice: string;
  cache: 'hit' | 'miss' | 'n/a';
  meta?: ResponseMeta;
  error?: string;
}

/** One line per synthesis attempt (F10 "All requests and failures are logged"). */
export function logRequest(fields: RequestLogFields): void {
  const meta = fields.meta;
  const parts = [
    'tts',
    `kind=${fields.kind}`,
    `req=${fields.requestId}`,
    `chunk=${fields.chunk}`,
    `block=${fields.block}`,
    `text=${fields.textLength}ch "${redactText(fields.text)}"`,
    `model=${fields.model}`,
    `voice=${fields.voice}`,
    `status=${meta ? meta.status : 'n/a'}`,
    `request-id=${meta?.requestId ?? 'null'}`,
    `dur=${meta?.durationMs ?? 0}ms`,
    `cache=${fields.cache}`,
  ];
  if (fields.error) {
    parts.push(`error=${JSON.stringify(fields.error)}`);
  }
  readAloudLog(parts.join(' '));
}
