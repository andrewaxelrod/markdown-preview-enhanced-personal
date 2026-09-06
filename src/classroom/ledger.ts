/**
 * The ledger (`featrues/13-classroom/spec.md` §9.4): what each chapter
 * reports after its prose, parsed tolerantly, and the module's running
 * registers the host merges it into.
 *
 * Pure module: no `vscode`, no I/O. The experiment's answers came back in
 * three layouts (prose lines, bold labels with bullets, bullets), which is
 * why the parser is tolerant rather than the skeleton strict.
 */

export interface LedgerPromise {
  text: string;
  /** The chapter that made the promise. */
  made: number;
  /** The chapter due to pay it, or null when none was named. */
  due: number | null;
  paid: boolean;
}

export interface LedgerExample {
  name: string;
  standsFor: string;
  /** The chapters that used it, first chapter first. */
  chapters: number[];
}

export interface LedgerTerm {
  term: string;
  gloss: string;
  /** The chapter that first glossed it. */
  chapter: number;
}

export interface LedgerAnalogy {
  concept: string;
  analogy: string;
  chapter: number;
}

export interface Ledger {
  promises: LedgerPromise[];
  examples: LedgerExample[];
  terms: LedgerTerm[];
  analogies: LedgerAnalogy[];
}

/** What one chapter's `## Ledger` block yields. */
export interface ParsedLedger {
  promises: { text: string; due: number | null }[];
  examples: { name: string; standsFor: string }[];
  terms: { term: string; gloss: string }[];
  analogies: { concept: string; analogy: string }[];
  /** False when no block was found; the caller logs it. */
  found: boolean;
}

export const LEDGER_HEADING_RE = /^\s*#{2,3}\s*ledger\s*:?\s*$/i;

export function emptyLedger(): Ledger {
  return { promises: [], examples: [], terms: [], analogies: [] };
}

function emptyParsed(found: boolean): ParsedLedger {
  return { promises: [], examples: [], terms: [], analogies: [], found };
}

type Section = keyof Omit<ParsedLedger, 'found'>;

/** `Promises`, `**Promises made**`, `### Examples used`, `Analogies:` → the section. */
function sectionOf(label: string): Section | null {
  const key = label.trim().toLowerCase();
  if (/^promise/.test(key)) {
    return 'promises';
  }
  if (/^example/.test(key)) {
    return 'examples';
  }
  if (/^term/.test(key) || /^gloss/.test(key)) {
    return 'terms';
  }
  if (/^analog/.test(key)) {
    return 'analogies';
  }
  return null;
}

function isNone(text: string): boolean {
  return /^\s*(?:\*\*)?none\b/i.test(text);
}

function clean(text: string): string {
  return text
    .replace(/\*\*/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[-–:]\s*/, '')
    .replace(/[.;,\s]+$/, '');
}

/** The first integer after the word "due" (case-insensitive), else null. */
function dueOf(text: string): number | null {
  const match = /\bdue\b[^0-9]*?(\d+)/i.exec(text);
  return match ? Number(match[1]) : null;
}

/** `text | due: 3`, `text. Due: chapter 3.` → the text without the due clause. */
function promiseText(item: string): string {
  const cut = item
    .replace(/\s*\|\s*due\b.*$/i, '')
    .replace(/[,.;\s]*\(?\bdue\b\s*:?[^.]*\.?\)?\s*$/i, '');
  return clean(cut);
}

/** `name: what it stands for` or `name, what it stands for`. */
function splitPair(item: string): [string, string] {
  const text = item.replace(/\*\*/g, '').trim();
  const colon = text.indexOf(':');
  const comma = text.indexOf(',');
  let at = -1;
  if (colon > 0 && (comma < 0 || colon < comma)) {
    at = colon;
  } else if (comma > 0) {
    at = comma;
  } else if (colon > 0) {
    at = colon;
  }
  if (at < 0) {
    return [clean(text), ''];
  }
  return [clean(text.slice(0, at)), clean(text.slice(at + 1))];
}

/**
 * §9.4 — parse the text after `## Ledger`. Headings may be `###` lines, bold
 * labels or `Promises made:` prose lines; items are bullets, or the rest of
 * a prose line split on semicolons; a lone _None._ is an empty section;
 * unknown headings are ignored; no block yields four empty lists.
 */
export function parseLedger(block: string | null | undefined): ParsedLedger {
  if (typeof block !== 'string' || !block.trim()) {
    return emptyParsed(false);
  }
  const lines = block.replace(/\r\n?/g, '\n').split('\n');
  const out = emptyParsed(true);
  let section: Section | null | 'unknown' = null;
  const items: Record<Section, string[]> = {
    promises: [],
    examples: [],
    terms: [],
    analogies: [],
  };
  const push = (text: string) => {
    if (section && section !== 'unknown' && text.trim()) {
      items[section].push(text.trim());
    }
  };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || LEDGER_HEADING_RE.test(line)) {
      continue;
    }
    const heading =
      /^#{1,6}\s*(.+?)\s*:?\s*$/.exec(line) ||
      /^\*\*(.+?)\*\*\s*:?\s*$/.exec(line);
    if (heading) {
      const found = sectionOf(heading[1]);
      section = found ?? 'unknown';
      continue;
    }
    // `Promises made: none.` or `**Terms glossed:** a, b; c, d` — a prose line.
    const prose =
      /^(?:\*\*)?([A-Za-z][A-Za-z ]{2,30}?)(?:\*\*)?\s*:\s*(.*)$/.exec(line);
    if (prose && sectionOf(prose[1]) && !/^[-*]/.test(line)) {
      section = sectionOf(prose[1]);
      const rest = prose[2].trim();
      if (rest && !isNone(rest)) {
        for (const item of rest.split(/;\s+/)) {
          push(item);
        }
      }
      continue;
    }
    const bullet = /^[-*+]\s+(.*)$/.exec(line);
    if (bullet) {
      push(bullet[1]);
      continue;
    }
    // A continuation line of the previous item, or a bare prose item.
    if (section && section !== 'unknown') {
      const list = items[section];
      if (list.length && !/^[A-Z]/.test(line)) {
        list[list.length - 1] += ' ' + line;
      } else {
        push(line);
      }
    }
  }
  for (const item of items.promises) {
    if (isNone(item)) {
      continue;
    }
    const text = promiseText(item);
    if (text) {
      out.promises.push({ text, due: dueOf(item) });
    }
  }
  for (const item of items.examples) {
    if (isNone(item)) {
      continue;
    }
    const [name, standsFor] = splitPair(item);
    if (name) {
      out.examples.push({ name, standsFor });
    }
  }
  for (const item of items.terms) {
    if (isNone(item)) {
      continue;
    }
    const [term, gloss] = splitPair(item);
    if (term) {
      out.terms.push({ term, gloss });
    }
  }
  for (const item of items.analogies) {
    if (isNone(item)) {
      continue;
    }
    const [concept, analogy] = splitPair(item);
    if (concept) {
      out.analogies.push({ concept, analogy });
    }
  }
  return out;
}

function sameKey(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * §9.4 — merge one chapter's ledger into the module's: promises appended
 * with `made` and `paid: false`; examples and analogies keyed by name, first
 * chapter kept, later chapters appended; terms keyed by term, first gloss
 * kept. The result is a new object; the input is not touched.
 */
export function mergeLedger(
  ledger: Ledger,
  parsed: ParsedLedger,
  chapter: number,
): Ledger {
  const next: Ledger = {
    promises: ledger.promises.map((p) => ({ ...p })),
    examples: ledger.examples.map((e) => ({
      ...e,
      chapters: e.chapters.slice(),
    })),
    terms: ledger.terms.map((t) => ({ ...t })),
    analogies: ledger.analogies.map((a) => ({ ...a })),
  };
  for (const promise of parsed.promises) {
    if (
      next.promises.some(
        (known) => sameKey(known.text, promise.text) && known.made === chapter,
      )
    ) {
      continue;
    }
    next.promises.push({
      text: promise.text,
      made: chapter,
      due: promise.due,
      paid: false,
    });
  }
  for (const example of parsed.examples) {
    const known = next.examples.find((e) => sameKey(e.name, example.name));
    if (known) {
      if (!known.chapters.includes(chapter)) {
        known.chapters.push(chapter);
      }
      if (!known.standsFor && example.standsFor) {
        known.standsFor = example.standsFor;
      }
    } else {
      next.examples.push({
        name: example.name,
        standsFor: example.standsFor,
        chapters: [chapter],
      });
    }
  }
  for (const term of parsed.terms) {
    if (!next.terms.some((t) => sameKey(t.term, term.term))) {
      next.terms.push({ term: term.term, gloss: term.gloss, chapter });
    }
  }
  for (const analogy of parsed.analogies) {
    if (!next.analogies.some((a) => sameKey(a.concept, analogy.concept))) {
      next.analogies.push({
        concept: analogy.concept,
        analogy: analogy.analogy,
        chapter,
      });
    }
  }
  return next;
}

/** §9.3 item 5 — the promises due in `chapter`, plus every earlier unpaid one. */
export function promisesDue(ledger: Ledger, chapter: number): LedgerPromise[] {
  return ledger.promises.filter(
    (promise) =>
      !promise.paid &&
      promise.due !== null &&
      promise.due <= chapter &&
      promise.made < chapter,
  );
}

/** D20 — the chapter numbered `due` passed its checks: its promises are paid. */
export function markPaid(ledger: Ledger, chapter: number): Ledger {
  return {
    ...ledger,
    promises: ledger.promises.map((promise) =>
      !promise.paid &&
      promise.due !== null &&
      promise.due <= chapter &&
      promise.made < chapter
        ? { ...promise, paid: true }
        : { ...promise },
    ),
  };
}
