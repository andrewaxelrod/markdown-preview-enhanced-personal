import { maskFences } from './checks';
import { CLASSROOM_CAPS } from './plan-prompt';

/**
 * Linked documents (`featrues/13-classroom/spec.md` §8.2): the markdown
 * files a document links to, found in its source, the selection's section
 * first, then the rest, de-duplicated; then resolved through an injected
 * resolver that says whether a target exists, is a file and lies inside a
 * workspace folder.
 *
 * Pure module: no `vscode`, no I/O.
 */

export type LinkKind = 'path' | 'wikilink';

export interface FoundLink {
  /** The target as written, fragment stripped. */
  target: string;
  kind: LinkKind;
  /** Where in the source the link sits. */
  index: number;
  /** Whether it sits inside the selection's section. */
  inSection: boolean;
}

export interface SectionRange {
  start: number;
  end: number;
}

/** What the controller's resolver answers for one target. */
export interface LinkResolution {
  fsPath: string;
  /** The workspace-relative path, for the sheet and the front matter. */
  relativePath: string;
}

export interface ResolvedLink extends FoundLink, LinkResolution {}

const SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
const PATH_LINK_RE =
  /(!?)\[[^\]\n]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"\n]*")?\s*\)/g;
const WIKILINK_RE = /\[\[([^\]\n]+?)\]\]/g;

function headingLevelOf(line: string): { level: number; text: string } | null {
  const match = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
  if (!match) {
    return null;
  }
  return { level: match[1].length, text: match[2].trim() };
}

function sameHeading(a: string, b: string): boolean {
  const norm = (text: string) =>
    text.replace(/[*_`]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
  return norm(a) === norm(b);
}

/**
 * §8.2 — the source range of the selection's section: from the heading line
 * of the breadcrumb's last level to the next heading of the same or a higher
 * level (or the end). Null when the heading cannot be found.
 */
export function sectionRangeFor(
  source: string,
  breadcrumb: string[],
): SectionRange | null {
  const wanted = breadcrumb.length ? breadcrumb[breadcrumb.length - 1] : '';
  if (!wanted.trim()) {
    return null;
  }
  const { prose } = maskFencesKeepingLength(source);
  const lines = prose.split('\n');
  let offset = 0;
  let start = -1;
  let level = 0;
  for (const line of lines) {
    const heading = headingLevelOf(line);
    if (heading) {
      if (start < 0) {
        if (sameHeading(heading.text, wanted)) {
          start = offset;
          level = heading.level;
        }
      } else if (heading.level <= level) {
        return { start, end: offset };
      }
    }
    offset += line.length + 1;
  }
  return start < 0 ? null : { start, end: source.length };
}

/** Fences blanked but their length kept, so indexes still point into `source`. */
function maskFencesKeepingLength(source: string): { prose: string } {
  const masked = maskFences(source);
  if (masked.tags.length === 0) {
    return { prose: source };
  }
  const prose = source.replace(
    /^(\s*)(```+|~~~+)([^\n]*)\n[\s\S]*?\n\s*\2[ \t]*$/gm,
    (match) => match.replace(/[^\n]/g, ' '),
  );
  return { prose };
}

function stripFragment(target: string): string {
  return target.replace(/[#^].*$/, '').trim();
}

function hasMarkdownExtension(target: string, extensions: string[]): boolean {
  const lower = target.toLowerCase();
  return extensions.some((ext) => {
    const suffix = ext.startsWith('.')
      ? ext.toLowerCase()
      : `.${ext.toLowerCase()}`;
    return lower.endsWith(suffix);
  });
}

/**
 * §8.2 — the link targets of the document: those inside the section first,
 * then the rest, each in order of appearance, de-duplicated. `[text](target)`
 * with a relative or absolute path target, and `[[target]]` wikilinks;
 * fragments stripped; schemes, images and non-markdown extensions ignored.
 */
export function findLinks(
  source: string,
  sectionRange: SectionRange | null,
  extensions: string[] = ['.md'],
): FoundLink[] {
  const { prose } = maskFencesKeepingLength(source);
  const found: FoundLink[] = [];
  const seen = new Set<string>();
  const add = (target: string, kind: LinkKind, index: number) => {
    const key = `${kind}:${target}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    found.push({
      target,
      kind,
      index,
      inSection:
        !!sectionRange &&
        index >= sectionRange.start &&
        index < sectionRange.end,
    });
  };
  let match: RegExpExecArray | null;
  PATH_LINK_RE.lastIndex = 0;
  while ((match = PATH_LINK_RE.exec(prose))) {
    if (match[1] === '!') {
      continue;
    }
    let target = match[2].trim();
    if (!target || SCHEME_RE.test(target)) {
      continue;
    }
    try {
      target = decodeURIComponent(target);
    } catch {
      /* keep as written */
    }
    target = stripFragment(target);
    if (!target || !hasMarkdownExtension(target, extensions)) {
      continue;
    }
    add(target, 'path', match.index);
  }
  WIKILINK_RE.lastIndex = 0;
  while ((match = WIKILINK_RE.exec(prose))) {
    const inner = match[1];
    let target = inner.split('|')[0].trim();
    target = stripFragment(target);
    if (!target || SCHEME_RE.test(target)) {
      continue;
    }
    if (
      /\.[A-Za-z0-9]+$/.test(target) &&
      !hasMarkdownExtension(target, extensions)
    ) {
      continue;
    }
    add(target, 'wikilink', match.index);
  }
  return found.sort((a, b) => {
    if (a.inSection !== b.inSection) {
      return a.inSection ? -1 : 1;
    }
    return a.index - b.index;
  });
}

/**
 * §8.2 — resolve the found links through the controller's resolver, keeping
 * those it accepts (exists, a file, inside a workspace folder) up to the cap,
 * and never the same file twice.
 */
export async function resolveLinks(
  links: FoundLink[],
  resolve: (link: FoundLink) => Promise<LinkResolution | null>,
  cap: number = CLASSROOM_CAPS.linkedDocuments,
): Promise<ResolvedLink[]> {
  const out: ResolvedLink[] = [];
  const seen = new Set<string>();
  for (const link of links) {
    if (out.length >= cap) {
      break;
    }
    let resolution: LinkResolution | null;
    try {
      resolution = await resolve(link);
    } catch {
      resolution = null;
    }
    if (!resolution || seen.has(resolution.fsPath)) {
      continue;
    }
    seen.add(resolution.fsPath);
    out.push({ ...link, ...resolution });
  }
  return out;
}

/** The first `h1` of a markdown source, else the fallback (the file name). */
export function titleOfSource(source: string, fallback: string): string {
  const { prose } = maskFences(source);
  const match = /^#\s+(.+?)\s*#*\s*$/m.exec(prose);
  return match ? match[1].trim().slice(0, 200) : fallback;
}
