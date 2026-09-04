/**
 * The model's answer is untrusted markdown (`featrues/04-help-module.md` §6).
 *
 * The document is untrusted input to the model, the answer comes back through
 * a CLI, and the preview's CSP allows inline scripts — so no raw HTML from an
 * answer may ever reach the page. Everything below runs *before*
 * `engine.parseMD`; the prompt also forbids HTML, but this escape is the
 * guarantee, not the prompt.
 *
 * Pure module: no `vscode`, no I/O.
 */

/** Longest answer the sheet will render; anything past this is dropped. */
export const MAX_ANSWER_CHARS = 40000;

/**
 * Link schemes that execute or carry a payload. `javascript:` and `data:` are
 * the two §6 names; `vbscript:` is the same class of thing on the engines that
 * still parse it, and costs nothing to add.
 */
const UNSAFE_SCHEME = 'javascript|data|vbscript';

/** `[text](javascript:…)`, with or without the whitespace markdown-it allows. */
const INLINE_TARGET_RE = new RegExp(
  `(\\]\\(\\s*<?)(${UNSAFE_SCHEME})\\s*:`,
  'gi',
);

/** A link reference definition: `[id]: javascript:…` at the start of a line. */
const REFERENCE_TARGET_RE = new RegExp(
  `(^[ \\t]{0,3}\\[[^\\]\\n]{1,200}\\][ \\t]*:[ \\t]*<?)(${UNSAFE_SCHEME})\\s*:`,
  'gim',
);

/**
 * Make one answer safe to hand to `parseMD`:
 *
 * 1. every `<` becomes `&lt;`, so no raw HTML tag and no autolink survives —
 *    the only cost is a literal `&lt;` inside a code span, which the prompt
 *    forbids anyway;
 * 2. `javascript:`, `data:` and `vbscript:` link targets are neutralised to
 *    `about:blank#…`, keeping the link text and losing the payload.
 *
 * Order matters: the escape runs first, so a target hidden behind an
 * angle-bracket destination (`](<javascript:…>)`) is already inert text by the
 * time the scheme rules look at it.
 */
export function sanitizeHelpAnswer(markdown: string): string {
  if (typeof markdown !== 'string') {
    return '';
  }
  const capped =
    markdown.length > MAX_ANSWER_CHARS
      ? markdown.slice(0, MAX_ANSWER_CHARS)
      : markdown;
  return capped
    .replace(/</g, '&lt;')
    .replace(INLINE_TARGET_RE, '$1about:blank#')
    .replace(REFERENCE_TARGET_RE, '$1about:blank#');
}

/**
 * What the CLI printed, tidied into the markdown the sheet stores and
 * follow-ups send back: CRLF normalised, a stray fence around the whole answer
 * removed (some models wrap everything in ```markdown), and trimmed. Empty
 * when the engine said nothing, which the controller reports as an error.
 */
export function normaliseHelpAnswer(raw: string): string {
  if (typeof raw !== 'string') {
    return '';
  }
  let text = raw.replace(/\r\n?/g, '\n').trim();
  const fenced = /^```[A-Za-z0-9_-]*\n([\s\S]*?)\n```$/.exec(text);
  if (fenced) {
    text = fenced[1].trim();
  }
  return text;
}
