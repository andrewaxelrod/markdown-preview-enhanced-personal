/* global suite, test, suiteSetup, suiteTeardown */

/**
 * `src/classroom/persona.ts` (`featrues/13-classroom/spec.md` §7, §17): the
 * package format, every front-matter refusal, the built-in Max and its three
 * edits, the replacement of a built-in by a user package, and the order of
 * the PERSONA and SPECIMEN sections.
 */

const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const { compileEntry } = require('./compile');

let persona;
let tmpFile;

const VALID = `---
name: Ada
id: ada
tagline: Explains with diagrams
audience: >-
  a reader who likes pictures
version: 2
levels:
  3: { chapters: [7, 9] }
---

# Ada's guide

Be brief.
`;

suite('classroom/persona', function () {
  this.timeout(30000);

  suiteSetup(async function () {
    tmpFile = path.join(__dirname, '.persona.bundle.cjs');
    persona = await compileEntry('src/classroom/persona.ts', tmpFile);
  });

  suiteTeardown(function () {
    if (tmpFile && fs.existsSync(tmpFile)) {
      fs.unlinkSync(tmpFile);
    }
  });

  test('a valid package parses with its front matter and body', function () {
    const parsed = persona.parsePersona(VALID, 'A specimen.\n');
    assert.strictEqual(persona.isPersonaParseError(parsed), false);
    assert.strictEqual(parsed.id, 'ada');
    assert.strictEqual(parsed.name, 'Ada');
    assert.strictEqual(parsed.tagline, 'Explains with diagrams');
    assert.strictEqual(parsed.audience, 'a reader who likes pictures');
    assert.strictEqual(parsed.version, 2);
    assert.deepStrictEqual(parsed.levels, { 3: { chapters: [7, 9] } });
    assert.strictEqual(parsed.body, "# Ada's guide\n\nBe brief.");
    assert.strictEqual(parsed.specimen, 'A specimen.');
    assert.strictEqual(parsed.builtIn, false);
  });

  test('each front-matter refusal names its reason', function () {
    const cases = [
      ['no front matter', 'Just a body'],
      ['bad id', VALID.replace('id: ada', 'id: Ada Lovelace')],
      ['long name', VALID.replace('name: Ada', 'name: ' + 'x'.repeat(81))],
      [
        'long tagline',
        VALID.replace(
          'tagline: Explains with diagrams',
          'tagline: ' + 'y'.repeat(81),
        ),
      ],
      ['bad version', VALID.replace('version: 2', 'version: zero')],
      [
        'bad level key',
        VALID.replace('  3: { chapters: [7, 9] }', '  4: { chapters: [7, 9] }'),
      ],
      ['bad level range', VALID.replace('[7, 9]', '[1, 12]')],
      ['inverted range', VALID.replace('[7, 9]', '[9, 7]')],
      ['no body', VALID.slice(0, VALID.indexOf("# Ada's guide"))],
    ];
    for (const [label, text] of cases) {
      const parsed = persona.parsePersona(text);
      assert.strictEqual(persona.isPersonaParseError(parsed), true, label);
      assert.ok(parsed.error.length > 0, label);
    }
  });

  test('the built-in Max parses, carries the three edits and nothing forbidden', function () {
    const max = persona.BUILT_IN_PERSONAS.find((p) => p.id === 'max');
    assert.ok(max, 'Max is registered');
    assert.strictEqual(max.name, 'Max');
    assert.strictEqual(max.version, 1);
    assert.strictEqual(max.builtIn, true);
    assert.ok(max.audience.startsWith('a professionally motivated reader'));
    // §7.3 edit 1: the reader is a parameter.
    assert.ok(
      max.body.includes(
        'The reader for this module is described as the audience in the instructions above.',
      ),
    );
    assert.ok(
      !max.body.includes('This audience definition replaces all earlier ones'),
    );
    // §7.3 edit 2: both chairs, generalised.
    assert.ok(
      max.body.includes(
        'user and builder, reader and author, operator and designer',
      ),
    );
    // §7.3 edit 3: the module stands alone.
    assert.ok(
      max.body.includes(
        'In a module written for one reader, there is no previous section.',
      ),
    );
    // No em dash anywhere, and no reference to what the host runs.
    assert.strictEqual((max.body.match(/—/g) || []).length, 0, 'no em dash');
    assert.strictEqual((max.specimen.match(/—/g) || []).length, 0);
    assert.ok(!/ElevenReader/.test(max.body));
    assert.ok(!/Part 8\b|Part 11\b|Part 12\b/.test(max.body));
    // The rulings stay.
    assert.ok(/No em dashes/.test(max.body));
    assert.ok(/No exercises/.test(max.body));
    // Part 7's first bullet: the preview's voice, not ElevenReader.
    assert.ok(max.body.includes("read aloud by the preview's own voice"));
    // The specimen: three chapters, cleaned into paragraphs.
    assert.ok(max.specimen.startsWith('The reference specimen'));
    assert.deepStrictEqual(
      Array.from(max.specimen.matchAll(/^## (.+)$/gm)).map((m) => m[1]),
      [
        'What Are AI Agents?',
        'How Agents Use Tools',
        'Understanding Session Context',
      ],
    );
    const words = max.specimen.split(/\s+/).length;
    assert.ok(words > 1400 && words < 1800, 'about 1,600 words: ' + words);
  });

  test('a user persona with a built-in id replaces it; others are appended', function () {
    const user = persona.parsePersona(
      VALID.replace('id: ada', 'id: max').replace(
        'name: Ada',
        'name: Max (edited)',
      ),
    );
    const other = persona.parsePersona(VALID);
    const merged = persona.mergePersonas([user, other]);
    assert.deepStrictEqual(
      merged.map((p) => p.id),
      ['max', 'ada'],
    );
    assert.strictEqual(merged[0].name, 'Max (edited)');
    assert.strictEqual(merged[0].builtIn, false);
    assert.strictEqual(persona.personaById(merged, 'ada').name, 'Ada');
    assert.strictEqual(persona.personaById(merged, 'nobody'), undefined);
  });

  test('personaPrompt puts PERSONA before SPECIMEN and omits an absent specimen', function () {
    const withSpecimen = persona.personaPrompt({
      body: 'BODY',
      specimen: 'SPEC',
    });
    assert.strictEqual(withSpecimen, '# PERSONA\n\nBODY\n\n# SPECIMEN\n\nSPEC');
    assert.strictEqual(
      persona.personaPrompt({ body: 'BODY', specimen: '' }),
      '# PERSONA\n\nBODY',
    );
  });

  test('personaSummary is the three fields the sheet shows', function () {
    const max = persona.BUILT_IN_PERSONAS[0];
    assert.deepStrictEqual(persona.personaSummary(max), {
      id: 'max',
      name: 'Max',
      tagline: 'A patient practitioner who explains the machinery one on one',
    });
  });
});
