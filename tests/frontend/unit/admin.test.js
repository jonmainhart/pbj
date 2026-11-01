import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseCSV, toCSV, restoreHeaders, canSwitch, resolveCSVHeaders} from '../../../site/assets/admin-model.js';
test('CSV round trips escaped commas, quotes, newlines and empty cells', () => {
    const table = {headers: ['NAME', 'NE SEA', 'TIEBREAKER'], rows: [['A, "B"\nC', 'N/P', '']]};
    assert.deepEqual(parseCSV(toCSV(table)), table);
});
test('CSV retains malformed row widths and accepts spreadsheet preamble', () => {
    assert.deepEqual(parseCSV('Title\r\nNAME,NE SEA,TIEBREAKER\r\nAlice,SEA,30,extra\r\n').rows, [['Alice','SEA','30','extra']]);
});
test('repairing schedule headers preserves alias picks and inserts missing cells', () => {
    assert.deepEqual(restoreHeaders({headers:['NAME','WAS JAC','TIEBREAKER'], rows:[['Alice','JAC','30']]},
        ['NAME','JAX WSH','NE SEA','TIEBREAKER']), {headers:['NAME','JAX WSH','NE SEA','TIEBREAKER'], rows:[['Alice','JAC','','30']]});
});
test('week switches warn only for unsaved changes and respect cancellation', () => {
    assert.equal(canSwitch(false, () => { throw Error('unexpected'); }), true);
    assert.equal(canSwitch(true, () => false), false);
    assert.equal(canSwitch(true, () => true), true);
});
for (const header of ['', 'PLAYER', 'NAEM']) {
    test(`CSV preserves a malformed NAME header (${JSON.stringify(header)}) and row widths`, () => {
        const table = {
            headers: [header, 'NE SEA', 'TIEBREAKER'],
            rows: [['Alice, "A"', 'SEA', '30', 'extra'], ['Bob', 'NE']],
        };
        assert.deepEqual(resolveCSVHeaders(parseCSV(toCSV(table)), 'headers'), table);
    });
}
for (const rows of [[['Alice', 'SEA', '30']], [['Alice', 'SEA', '30', 'extra'], ['Bob', 'NE'], ['', '', '']]]) {
    test(`headerless CSV preserves all ${rows.length} rows until an explicit choice`, () => {
        const csv = rows.map(row => row.join(',')).join('\n') + '\n';
        const parsed = parseCSV(csv);
        assert.deepEqual(parsed, {headers: [], rows, needsHeaderChoice: true});
        assert.throws(() => restoreHeaders(parsed, ['NAME','NE SEA','TIEBREAKER']), /first row/i);
        assert.throws(() => toCSV(parsed), /first row/i);
        const table = resolveCSVHeaders(parsed, 'players', ['NAME','NE SEA','TIEBREAKER']);
        assert.deepEqual(table.rows, rows);
        assert.deepEqual(table.headers, ['NAME','NE SEA','TIEBREAKER']);
        table.rows[0][2] = '42';
        assert.equal(toCSV(table).split('\r\n')[1], rows[0].map((c, i) => `"${i === 2 ? '42' : c}"`).join(','));
    });
}
test('CSV empty inputs and header-only tables remain editable', () => {
    assert.deepEqual(parseCSV(''), {headers: [], rows: []});
    assert.deepEqual(parseCSV('NAME,NE SEA,TIEBREAKER\n'), {
        headers: ['NAME', 'NE SEA', 'TIEBREAKER'], rows: [],
    });
});
const scheduleHeaders = ['NAME', 'NE SEA', 'TIEBREAKER'];
for (const [label, table, diagnostic] of [
    ['PLAYER header', {headers:['PLAYER','NE SEA','TIEBREAKER'], rows:[['Alice','SEA','30']]}, /row 1, column 1.*PLAYER/i],
    ['misspelled NAME', {headers:['NAEM','NE SEA','TIEBREAKER'], rows:[['Alice','SEA','30']]}, /NAEM/],
    ['duplicate matchup', {headers:['NAME','NE SEA','SEA NE','TIEBREAKER'], rows:[['Alice','SEA','NE','30']]}, /columns 2, 3.*ambiguous/i],
    ['alias collision', {headers:['NAME','JAC WAS','WSH JAX','TIEBREAKER'], rows:[['Alice','JAC','WSH','30']]}, /columns 2, 3.*ambiguous/i],
    ['extra populated cell', {headers:scheduleHeaders, rows:[['Alice','SEA','30','keep me']]}, /row 1, column 4.*beyond/i],
    ['unknown populated column', {headers:[...scheduleHeaders,'NOTES'], rows:[['Alice','SEA','30','keep me']]}, /row 1, column 4.*NOTES/i],
]) {
    test(`header repair rejects ${label} without changing any original values`, () => {
        const original = structuredClone(table), csv = toCSV(table);
        const target = label === 'alias collision' ? ['NAME','JAX WSH','TIEBREAKER'] : scheduleHeaders;
        assert.throws(() => restoreHeaders(table, target), diagnostic);
        assert.deepEqual(table, original);
        assert.equal(toCSV(table), csv);
    });
}
test('header repair allows empty unmatched columns and empty cells beyond the header width', () => {
    const table = {headers:[...scheduleHeaders,'NOTES'], rows:[['Alice','SEA','30','','']]};
    assert.deepEqual(restoreHeaders(table, scheduleHeaders), {headers:scheduleHeaders,rows:[['Alice','SEA','30']]});
});
test('manual header correction makes repair safe and retains names, picks and tiebreakers', () => {
    const table = {headers:['PLAYER',' sea ne ','TIEBREAKER'], rows:[['Alice','SEA','30']]};
    assert.throws(() => restoreHeaders(table, scheduleHeaders), /Correct.*headers/i);
    table.headers[0] = 'NAME';
    const repaired = restoreHeaders(table, scheduleHeaders);
    assert.deepEqual(repaired.rows, [['Alice','SEA','30']]);
    repaired.rows[0][2] = '42';
    assert.equal(toCSV(repaired), '"NAME","NE SEA","TIEBREAKER"\r\n"Alice","SEA","42"\r\n');
});
