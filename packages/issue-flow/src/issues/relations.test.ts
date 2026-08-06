import { describe, expect, it } from 'vitest';
import {
  emptyRelations,
  hasNoRelations,
  mergeRelations,
  parseTextualRelations,
  uniqueIds,
} from './relations.js';

describe('emptyRelations', () => {
  it('describes an Issue that relates to nothing', () => {
    const relations = emptyRelations('42');
    expect(relations).toEqual({
      id: '42',
      parent: null,
      children: [],
      blockedBy: [],
      blocking: [],
      references: [],
      referencedBy: [],
      heuristic: [],
    });
    expect(hasNoRelations(relations)).toBe(true);
  });

  it('does not consider a plain mention a relation', () => {
    expect(hasNoRelations({ ...emptyRelations('42'), references: ['7'] })).toBe(true);
    expect(hasNoRelations({ ...emptyRelations('42'), blockedBy: ['7'] })).toBe(false);
  });
});

describe('uniqueIds', () => {
  it('deduplicates preserving order and drops the Issue itself', () => {
    expect(uniqueIds(['3', '1', '3', '', ' 2 ', '1'], '2')).toEqual(['3', '1']);
  });
});

describe('parseTextualRelations', () => {
  it('reads dependencies from the documented keywords', () => {
    const body = ['Depends on #12', 'Blocked by #13', 'Blocks #14'].join('\n');
    expect(parseTextualRelations(body)).toMatchObject({
      blockedBy: ['12', '13'],
      blocking: ['14'],
    });
  });

  it('reads the Portuguese spellings issues are actually written in', () => {
    const body = ['Depende de #50', 'Bloqueada por #51', 'Bloqueia #52', 'Requer #53'].join('\n');
    expect(parseTextualRelations(body)).toMatchObject({
      blockedBy: ['50', '51', '53'],
      blocking: ['52'],
    });
  });

  it('accepts hyphenated and colon spellings', () => {
    expect(parseTextualRelations('Depends-on: #12\nBlocked-by: #13')).toMatchObject({
      blockedBy: ['12', '13'],
    });
  });

  it('reads a comma/and separated list after one keyword', () => {
    expect(parseTextualRelations('Blocked by #1, #2 and #3')).toMatchObject({
      blockedBy: ['1', '2', '3'],
    });
  });

  it('reads through a parenthetical gloss between two ids', () => {
    expect(
      parseTextualRelations('Depende de #50 (descoberta de dependências) e #51 (plano ordenado)'),
    ).toMatchObject({ blockedBy: ['50', '51'] });
  });

  it('stops the list when the separator is not followed by another id', () => {
    expect(parseTextualRelations('Depends on #50 (already merged), see also #99')).toMatchObject({
      blockedBy: ['50'],
      references: ['99'],
    });
  });

  it('reads task list items as sub-issues', () => {
    const body = ['- [ ] #21 first', '- [x] #22 second', '* [ ] #23 third'].join('\n');
    expect(parseTextualRelations(body).children).toEqual(['21', '22', '23']);
  });

  it('keeps only the citation that opens a task item', () => {
    expect(parseTextualRelations('- [ ] #21 depends on the work in #99').children).toEqual(['21']);
  });

  it('does not read a task item that merely mentions an issue in its prose', () => {
    const parsed = parseTextualRelations('- [ ] Reuse the graph built for issue #50');
    expect(parsed.children).toEqual([]);
    expect(parsed.references).toEqual(['50']);
  });

  it('demotes every other citation to a plain reference', () => {
    const parsed = parseTextualRelations('Related to #7. Blocked by #8. See also #9.');
    expect(parsed.references).toEqual(['7', '9']);
    expect(parsed.blockedBy).toEqual(['8']);
  });

  it('ignores citations inside code spans and fenced blocks', () => {
    const body = ['`Blocked by #99`', '```', 'Depends on #98', '```', 'Depends on #1'].join('\n');
    const parsed = parseTextualRelations(body);
    expect(parsed.blockedBy).toEqual(['1']);
    expect(parsed.references).toEqual([]);
  });

  it('does not read a keyword that is not immediately followed by an id', () => {
    expect(parseTextualRelations('Blocked by the API redesign discussed in #12')).toMatchObject({
      blockedBy: [],
      references: ['12'],
    });
  });

  it('never relates an Issue to itself', () => {
    expect(parseTextualRelations('Part 2 of #51. Depends on #51.', '51')).toMatchObject({
      blockedBy: [],
      references: [],
    });
  });

  it('ignores a number glued to a word', () => {
    expect(parseTextualRelations('commit abc#12').references).toEqual([]);
  });

  it('tolerates an empty body', () => {
    expect(parseTextualRelations('')).toEqual({
      children: [],
      blockedBy: [],
      blocking: [],
      references: [],
    });
  });
});

describe('mergeRelations', () => {
  const structured = {
    id: '50',
    parent: '49' as string | null,
    children: ['51'],
    blockedBy: ['48'],
    blocking: [],
    references: [],
    referencedBy: ['80'],
  };

  it('lists structured ids first and flags the heuristic-only ones', () => {
    const merged = mergeRelations(structured, {
      children: ['51', '52'],
      blockedBy: ['47'],
      blocking: ['53'],
      references: ['9'],
    });

    expect(merged.children).toEqual(['51', '52']);
    expect(merged.blockedBy).toEqual(['48', '47']);
    expect(merged.blocking).toEqual(['53']);
    expect(merged.references).toEqual(['9']);
    expect(merged.referencedBy).toEqual(['80']);
    // '51' was confirmed by the API, so it is not a guess any more.
    expect(merged.heuristic).toEqual(['52', '47', '53']);
  });

  it('marks nothing as heuristic when the text adds nothing', () => {
    const merged = mergeRelations(structured, {
      children: ['51'],
      blockedBy: [],
      blocking: [],
      references: [],
    });
    expect(merged.heuristic).toEqual([]);
  });
});
