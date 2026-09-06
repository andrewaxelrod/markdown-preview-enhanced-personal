import { parse as parseYaml } from 'yaml';
import maxPersonaText from './personas/max/persona.md';
import maxSpecimenText from './personas/max/specimen.md';

/**
 * The persona package (`featrues/13-classroom/spec.md` §7): a folder holding
 * `persona.md` (front matter plus the instructor's parts, sent verbatim as the
 * PERSONA section of the system prompt) and, optionally, `specimen.md` (a
 * transcript of the instructor speaking, sent after it).
 *
 * Pure module: no `vscode`, no I/O. The built-in personas are imported as
 * text so the packaged `.vsix` needs no runtime file lookup; the controller
 * reads user packages from `<classroom root>/personas/<id>/` and hands their
 * text here.
 */

export const PERSONA_ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const PERSONA_NAME_MAX_CHARS = 80;
export const PERSONA_TAGLINE_MAX_CHARS = 80;
export const PERSONA_AUDIENCE_MAX_CHARS = 300;
export const PERSONA_LEVEL_CHAPTERS_MIN = 2;
export const PERSONA_LEVEL_CHAPTERS_MAX = 10;
export const DEFAULT_PERSONA_ID = 'max';

export type ClassroomLevel = 1 | 2 | 3;

/** §7.1 — a per-level override of the chapter budget of §6. */
export interface PersonaLevelOverride {
  chapters: [number, number];
}

export interface Persona {
  id: string;
  name: string;
  tagline: string;
  audience: string;
  version: number;
  levels: Partial<Record<ClassroomLevel, PersonaLevelOverride>>;
  /** §6.1 — the same overrides for a term-shaped passage. */
  termLevels: Partial<Record<ClassroomLevel, PersonaLevelOverride>>;
  /** The body of `persona.md`: the PERSONA section, verbatim. */
  body: string;
  /** The body of `specimen.md`, or '' when the package has none. */
  specimen: string;
  /** False for a package read from the classroom root. */
  builtIn: boolean;
}

export interface PersonaParseError {
  error: string;
}

export function isPersonaParseError(
  value: Persona | PersonaParseError,
): value is PersonaParseError {
  return typeof (value as PersonaParseError).error === 'string';
}

/** What the sheet's select and `readAloudClassroomPrepared` carry (§14.3). */
export interface PersonaSummary {
  id: string;
  name: string;
  tagline: string;
}

export function personaSummary(persona: Persona): PersonaSummary {
  return { id: persona.id, name: persona.name, tagline: persona.tagline };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The front matter and the body of a `persona.md`; null without a fence. */
function splitFrontMatter(text: string): { yaml: string; body: string } | null {
  const source = text.replace(/\r\n?/g, '\n');
  if (!source.startsWith('---\n')) {
    return null;
  }
  const close = source.indexOf('\n---', 4);
  if (close < 0) {
    return null;
  }
  const fenceEnd = close + 4;
  if (fenceEnd < source.length && source[fenceEnd] !== '\n') {
    return null;
  }
  return {
    yaml: source.slice(4, close + 1),
    body: source.slice(Math.min(source.length, fenceEnd + 1)).trim(),
  };
}

function parseLevels(
  value: unknown,
  name: string = 'levels',
): Partial<Record<ClassroomLevel, PersonaLevelOverride>> | string {
  if (value === undefined || value === null) {
    return {};
  }
  if (!isPlainObject(value)) {
    return `${name} is not a mapping`;
  }
  const out: Partial<Record<ClassroomLevel, PersonaLevelOverride>> = {};
  for (const key of Object.keys(value)) {
    const level = Number(key);
    if (level !== 1 && level !== 2 && level !== 3) {
      return `${name} has an unknown level ${JSON.stringify(key)}`;
    }
    const entry = value[key];
    if (!isPlainObject(entry) || !Array.isArray(entry.chapters)) {
      return `${name}.${key} needs a chapters pair`;
    }
    const [min, max] = entry.chapters as unknown[];
    if (
      typeof min !== 'number' ||
      typeof max !== 'number' ||
      !Number.isInteger(min) ||
      !Number.isInteger(max) ||
      min < PERSONA_LEVEL_CHAPTERS_MIN ||
      max > PERSONA_LEVEL_CHAPTERS_MAX ||
      min > max
    ) {
      return `${name}.${key}.chapters must be [min, max] with 2 ≤ min ≤ max ≤ 10`;
    }
    out[level as ClassroomLevel] = { chapters: [min, max] };
  }
  return out;
}

/**
 * §7.1 — parse one package. The front matter is validated field by field;
 * an invalid package is reported with the reason and skipped by the caller.
 */
export function parsePersona(
  text: string,
  specimen: string = '',
  builtIn: boolean = false,
): Persona | PersonaParseError {
  if (typeof text !== 'string') {
    return { error: 'persona.md is not text' };
  }
  const split = splitFrontMatter(text);
  if (!split) {
    return { error: 'persona.md has no front matter' };
  }
  let front: unknown;
  try {
    front = parseYaml(split.yaml);
  } catch (error) {
    return {
      error: `front matter does not parse: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (!isPlainObject(front)) {
    return { error: 'front matter is not a mapping' };
  }
  const id = typeof front.id === 'string' ? front.id.trim() : '';
  if (!PERSONA_ID_RE.test(id)) {
    return {
      error: `id ${JSON.stringify(front.id ?? '')} is not a persona id`,
    };
  }
  const name = typeof front.name === 'string' ? front.name.trim() : '';
  if (!name || name.length > PERSONA_NAME_MAX_CHARS) {
    return { error: 'name is missing or longer than 80 characters' };
  }
  const tagline = typeof front.tagline === 'string' ? front.tagline.trim() : '';
  if (tagline.length > PERSONA_TAGLINE_MAX_CHARS) {
    return { error: 'tagline is longer than 80 characters' };
  }
  const audience =
    typeof front.audience === 'string'
      ? front.audience.replace(/\s+/g, ' ').trim()
      : '';
  if (audience.length > PERSONA_AUDIENCE_MAX_CHARS) {
    return { error: 'audience is longer than 300 characters' };
  }
  const version = front.version;
  if (
    typeof version !== 'number' ||
    !Number.isInteger(version) ||
    version < 1
  ) {
    return { error: 'version must be a positive integer' };
  }
  const levels = parseLevels(front.levels);
  if (typeof levels === 'string') {
    return { error: levels };
  }
  const termLevels = parseLevels(front.termLevels, 'termLevels');
  if (typeof termLevels === 'string') {
    return { error: termLevels };
  }
  if (!split.body) {
    return { error: 'persona.md has no body' };
  }
  return {
    id,
    name,
    tagline,
    audience,
    version,
    levels,
    termLevels,
    body: split.body,
    specimen:
      typeof specimen === 'string'
        ? specimen.replace(/\r\n?/g, '\n').trim()
        : '',
    builtIn,
  };
}

/**
 * §21.1 — the PERSONA and SPECIMEN sections of the system prompt, in that
 * order; the SPECIMEN heading is left out when the package has none.
 */
export function personaPrompt(
  persona: Pick<Persona, 'body' | 'specimen'>,
): string {
  const parts = [`# PERSONA\n\n${persona.body}`];
  if (persona.specimen) {
    parts.push(`# SPECIMEN\n\n${persona.specimen}`);
  }
  return parts.join('\n\n');
}

function builtIn(text: string, specimen: string): Persona {
  const parsed = parsePersona(text, specimen, true);
  if (isPersonaParseError(parsed)) {
    // A built-in that does not parse is a build error, not a runtime one.
    throw new Error(`built-in persona does not parse: ${parsed.error}`);
  }
  return parsed;
}

/** §7.1 — the registry of bundled personas; Max is the one this revision ships. */
export const BUILT_IN_PERSONAS: readonly Persona[] = [
  builtIn(maxPersonaText, maxSpecimenText),
];

/**
 * §7.1 — the personas in force: the built-ins, with a user package of the
 * same `id` replacing its built-in (that is how Max is edited without a
 * rebuild), then the other user packages, in the order given.
 */
export function mergePersonas(
  users: readonly Persona[],
  builtIns: readonly Persona[] = BUILT_IN_PERSONAS,
): Persona[] {
  const out: Persona[] = [];
  const seen = new Set<string>();
  for (const persona of builtIns) {
    const replacement = users.find((user) => user.id === persona.id);
    out.push(replacement ?? persona);
    seen.add(persona.id);
  }
  for (const user of users) {
    if (!seen.has(user.id)) {
      out.push(user);
      seen.add(user.id);
    }
  }
  return out;
}

/** The persona named by `classroomPersona`, else `max` (§7.1, with a log line by the caller). */
export function personaById(
  personas: readonly Persona[],
  id: string,
): Persona | undefined {
  return personas.find((persona) => persona.id === id);
}
