import { escapeField } from '../read-aloud/help-prompt';
import { ruleText, type CheckBrief, type CheckFailure } from './checks';
import type { Ledger, LedgerPromise } from './ledger';
import type { ClassroomLevel } from './persona';
import {
  LEVELS,
  serializeChapterLine,
  serializePlan,
  type Plan,
  type PlanChapter,
} from './plan-prompt';

/**
 * The classroom prompts, part two (`featrues/13-classroom/spec.md` §9.3–§9.6,
 * §21.3–§21.5): the chapter brief, the retry and the return chapter.
 *
 * Pure module: no `vscode`, no I/O. Every value from the document, the plan
 * or the reader goes through `escapeField` before it is placed.
 */

/** §9.4 — the block every chapter request asks for after the prose. */
export const LEDGER_SKELETON = `## Ledger
### Promises
- <what was promised, in a few words> | due: <chapter number, or none>
### Examples
- <name>: <what it stands for>
### Terms
- <term>: <the plain-words gloss used>
### Analogies
- <concept>: <the everyday analogy>`;

export interface ChapterBrief {
  plan: Plan;
  chapter: PlanChapter;
  level: ClassroomLevel;
  readerNote: string;
  document: { title: string; breadcrumb: string[] };
  passage: string;
  /** The previous chapter's closing bridge, verbatim; null for the first. */
  previousBridge: string | null;
  /** The next chapter, or null for the last. */
  next: PlanChapter | null;
  ledger: Ledger;
  promisesDue: LedgerPromise[];
  target: number;
  ceiling: number;
}

function firstSentenceOf(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const match = /^(.+?[.!?])(\s|$)/.exec(flat);
  return match ? match[1] : flat.slice(0, 200);
}

function listOrNone(items: string[]): string {
  return items.length ? items.join('; ') : 'none';
}

/** The page-mechanics reminder and the word target (§21.3). */
function templateHead(brief: ChapterBrief, template: string): string {
  return `The module plan below was agreed. Write chapter ${brief.chapter.n} only, in full, as markdown prose: the
chapter title as a level-2 heading, then the prose. ${template}
Page mechanics: no tables, no links, no inline code, no HTML, no emoji, no em dashes;
figures only as fenced blocks tagged ascii, introduced by name before the fence and narrated
after it, at most one unless a second earns its place. Word target: about ${brief.target} words,
never more than ${brief.ceiling}.`;
}

const ORDINARY_TEMPLATE =
  'Follow the chapter template: the pickup,\nthe first-pass answer, the zoom-in, the turns, the consolidation, the close with a bridge.';

/** §21.5 — the return chapter's instruction, in place of the template sentence. */
export function returnInstruction(passage: string): string {
  return `This is the return chapter. Open by picking up the previous bridge, then take the passage
below one sentence at a time, in order. For each sentence, say it in your own words first,
then say what the reader now knows that makes it plain, naming the chapter that gave it to
them. Do not quote the passage verbatim. Close with the one-breath recap of the module and an
invitation to read the passage again in the document, in the persona's voice. No bridge to a
next chapter: this is the last.

<passage>
${escapeField(passage.trim())}
</passage>`;
}

/** The pickup, the handover, the promises and the registries (§9.3 items 3–6). */
function briefBody(brief: ChapterBrief): string {
  const lines: string[] = [];
  lines.push(`<plan>\n${escapeField(serializePlan(brief.plan))}\n</plan>`);
  lines.push(
    `This chapter: ${escapeField(serializeChapterLine(brief.chapter))}`,
  );
  if (brief.previousBridge === null) {
    const level = LEVELS[brief.level];
    const note = brief.readerNote.replace(/\s+/g, ' ').trim();
    lines.push(
      `This is the first chapter. Open from the reader's situation: they were
reading "${escapeField(brief.document.title)}" under "${escapeField(brief.document.breadcrumb.join(' › '))}", stopped at the passage that begins
"${escapeField(firstSentenceOf(brief.passage))}"` +
        (note ? `, and said, in their words: "${escapeField(note)}"` : '') +
        `. They are at
level ${brief.level} of 3: ${level.row}. There is no previous section or module: this module stands
alone.`,
    );
  } else {
    lines.push(
      `Previous chapter's closing bridge, verbatim; open by echoing it:\n${escapeField(brief.previousBridge.trim())}`,
    );
  }
  if (brief.next) {
    lines.push(
      `Next chapter's question, to hand over in the bridge: ${brief.next.n}. ${escapeField(brief.next.title)}: ${escapeField(brief.next.question)}`,
    );
  } else {
    lines.push('This is the last chapter.');
  }
  lines.push(
    `Promises due in this chapter: ${listOrNone(
      brief.promisesDue.map(
        (promise) =>
          `${escapeField(promise.text)} (made in chapter ${promise.made})`,
      ),
    )}`,
  );
  const examples = brief.ledger.examples.map((example) =>
    example.standsFor
      ? `${escapeField(example.name)}: ${escapeField(example.standsFor)}`
      : escapeField(example.name),
  );
  if (brief.plan.example && !examples.length) {
    examples.push(escapeField(brief.plan.example));
  }
  lines.push(
    `Example registry (reuse before inventing; mark a callback when reusing): ${listOrNone(examples)}`,
  );
  lines.push(
    `Terms glossed so far (gloss each again on first use in this chapter, in the same words):
${listOrNone(
  brief.ledger.terms.map(
    (term) => `${escapeField(term.term)}: ${escapeField(term.gloss)}`,
  ),
)}`,
  );
  lines.push(
    `Analogy registry (one analogy per concept; never a second): ${listOrNone(
      brief.ledger.analogies.map(
        (analogy) =>
          `${escapeField(analogy.concept)}: ${escapeField(analogy.analogy)}`,
      ),
    )}`,
  );
  lines.push(
    `After the chapter, add a section headed "## Ledger" in exactly this shape; it is for the
build, not the reader, and is removed before the module is shown:

${LEDGER_SKELETON}`,
  );
  return lines.join('\n\n');
}

/** §21.3 — the user message of an ordinary chapter. */
export function buildOrdinaryChapterRequest(brief: ChapterBrief): string {
  return `${templateHead(brief, ORDINARY_TEMPLATE)}\n\n${briefBody(brief)}`;
}

/** §21.5 — the last chapter's request: the template sentence replaced. */
export function buildReturnRequest(brief: ChapterBrief): string {
  return `${templateHead(brief, returnInstruction(brief.passage))}\n\n${briefBody(brief)}`;
}

/** §9.3 — one chapter's request, by its type. */
export function buildChapterRequest(brief: ChapterBrief): string {
  return brief.chapter.type === 'return'
    ? buildReturnRequest(brief)
    : buildOrdinaryChapterRequest(brief);
}

/** §21.4 — the same request with the draft and the failed rules appended. */
export function buildRetryRequest(
  brief: ChapterBrief,
  draft: string,
  failures: CheckFailure[],
  words: number,
): string {
  const checkBrief: Pick<CheckBrief, 'target' | 'ceiling'> = {
    target: brief.target,
    ceiling: brief.ceiling,
  };
  const rules = failures
    .map(
      (failure) =>
        `- ${failure.code}: ${ruleText(failure.code, checkBrief, words)}`,
    )
    .join('\n');
  return `${buildChapterRequest(brief)}

Your previous draft of this chapter is below. It failed these checks:
${rules}
Rewrite the whole chapter so that every check passes, keeping what was good. Return the
whole chapter again, with its Ledger.

<draft>
${escapeField(draft.trim())}
</draft>`;
}
