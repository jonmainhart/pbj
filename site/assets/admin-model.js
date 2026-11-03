/** Small RFC 4180 parser: retain malformed row widths for backend diagnostics. */
export function parseCSV(text) {
    const rows = []; let row = [], cell = '', quoted = false;
    text = text.replace(/^\uFEFF/, '');
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (c === '"') {
            if (quoted && text[i + 1] === '"') { cell += '"'; i++; }
            else if (!cell || quoted) quoted = !quoted;
            else cell += c;
        } else if (c === ',' && !quoted) { row.push(cell); cell = ''; }
        else if ((c === '\n' || c === '\r') && !quoted) {
            if (c === '\r' && text[i + 1] === '\n') i++;
            row.push(cell); rows.push(row); row = []; cell = '';
        } else cell += c;
    }
    if (quoted) throw new Error('Unclosed CSV quote. Correct the source file before uploading.');
    if (cell || row.length) { row.push(cell); rows.push(row); }
    const start = rows.findIndex(r => r[0]?.trim().toUpperCase() === 'NAME');
    if (start < 0 && rows.length) return {headers: [], rows, needsHeaderChoice: true};
    return { headers: rows[start] || [], rows: rows.slice(start + 1).filter(r => r.some(c => c.trim())) };
}
export function resolveCSVHeaders(table, choice, scheduleHeaders = []) {
    if (choice === 'headers') return {headers: table.rows[0] || [], rows: table.rows.slice(1)};
    if (choice === 'players') return {headers: scheduleHeaders, rows: table.rows};
    throw new Error('Choose whether the first row contains headers or player data.');
}
export function toCSV({headers, rows, needsHeaderChoice}) {
    if (needsHeaderChoice) throw new Error('Choose how to interpret the first row before continuing.');
    return [headers, ...rows].map(row => row.map(value => `"${String(value).replaceAll('"', '""')}"`).join(',')).join('\r\n') + '\r\n';
}
export function restoreHeaders(table, headers) {
    if (table.needsHeaderChoice) throw new Error('Choose how to interpret the first row before repairing headers.');
    const columns = table.headers.map(normalizedHeader);
    const targets = headers.map(normalizedHeader);
    const diagnostics = [];
    for (const target of new Set(targets)) {
        const sources = columns.flatMap((column, c) => column === target ? [c] : []);
        if (sources.length > 1) diagnostics.push(`Columns ${sources.map(c => c + 1).join(', ')} have ambiguous mappings to ${headers[targets.indexOf(target)]}`);
        if (targets.filter(column => column === target).length > 1) diagnostics.push(`Schedule headers have an ambiguous mapping for ${target}`);
    }
    table.rows.forEach((row, r) => row.forEach((value, c) => {
        if (value === '' || value == null) return;
        if (c >= columns.length) diagnostics.push(`Row ${r + 1}, column ${c + 1} is populated beyond the header width`);
        else if (!targets.includes(columns[c])) diagnostics.push(`Row ${r + 1}, column ${c + 1} (${JSON.stringify(table.headers[c])}) has data with no matching schedule header`);
    }));
    if (diagnostics.length) throw new Error(`Header repair stopped; no data changed. ${diagnostics.join('; ')}. Correct the indicated headers or move the affected cell values to matching columns, then retry.`);
    return {headers, rows: table.rows.map(row => targets.map(target => row[columns.indexOf(target)] ?? ''))};
}
export function canSwitch(dirty, confirm) { return !dirty || confirm('Discard unsaved edits?'); }


const normalizedHeader = value => value.trim().toUpperCase().split(/\s+/).map(v => ({JAC:'JAX', WAS:'WSH'}[v] || v)).sort().join(' ');
export function matchupFor(header, headers, games) {
    const key = normalizedHeader(header);
    const matches = games.filter(game => normalizedHeader(`${game.away} ${game.home}`) === key);
    if (matches.length !== 1 || headers.filter(value => normalizedHeader(value) === key).length !== 1) return null;
    return matches[0];
}
/** Reversed order and aliases are accepted representations, not repair problems. */
export function needsHeaderRepair(table, expected) {
    if (table.needsHeaderChoice || !expected.length) return false;
    const actual = table.headers.map(normalizedHeader), target = expected.map(normalizedHeader);
    return table.headers[0]?.trim() !== 'NAME' || !table.headers.some(header => header.trim() === 'TIEBREAKER') ||
        actual.length !== target.length || target.some(key => actual.filter(value => value === key).length !== 1);
}
