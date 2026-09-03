import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * The plain-text record of what is sent to ElevenLabs: one line per request,
 * the `text` field verbatim, nothing else. A cache hit sends nothing, so it
 * never appears. The file lives at `<workspace folder>/logs/read-aloud-sent.log`
 * for the document being read, or under the extension's global storage when
 * the document has no workspace folder (the controller picks the base).
 *
 * Node `fs` only, no `vscode` import, so it is unit-testable against a temp
 * directory. Best effort: a logging failure must never break playback.
 */

export const SENT_LOG_RELATIVE_PATH = path.join('logs', 'read-aloud-sent.log');

export function sentLogPath(baseDir: string): string {
  return path.join(baseDir, SENT_LOG_RELATIVE_PATH);
}

/** Append `text` as one line. Line breaks inside it are flattened to spaces. */
export async function appendSentText(
  baseDir: string,
  text: string,
): Promise<void> {
  const file = sentLogPath(baseDir);
  try {
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.appendFile(
      file,
      `${text.replace(/[\r\n]+/g, ' ')}\n`,
      'utf8',
    );
  } catch {
    // Best effort.
  }
}
