import {parseCSV, toCSV, canSwitch, restoreHeaders, resolveCSVHeaders} from './admin-model.js';
import {beginLogin, finishLogin} from './admin-auth.js';
const $ = id => document.getElementById(id);
let config, token, catalog, selection, table = {headers: [], rows: []}, etag = null, dirty = false, busy = false;
const status = text => { $('status').textContent = text; };
function changed(value = true) { dirty = value; $('dirty').textContent = dirty ? 'Unsaved changes' : 'Draft up to date'; }
async function api(path, method = 'GET', body) {
    const res = await fetch(config.api + path, {method, cache: 'no-store', headers: {
        Authorization: `Bearer ${token}`, ...(body ? {'Content-Type': 'application/json'} : {})},
        ...(body ? {body: JSON.stringify(body)} : {})});
    const result = await res.json();
    if (!res.ok) {
        if (result.etag) etag = result.etag;
        if (result.issues) showIssues(result.issues);
        if (res.status === 401 || res.status === 403) status('Session expired. Sign in again; copy any unsaved edits first.');
        throw new Error(result.message || 'Request failed');
    }
    return result;
}
function path(action = '') { return `/weeks/${selection.season}/${selection.week}${action ? '/' + action : ''}`; }
function render() {
    const head = $('picks').querySelector('thead'); head.replaceChildren();
    const tr = document.createElement('tr');
    table.headers.forEach((value, c) => {
        const th = document.createElement('th'), input = document.createElement('input');
        input.dataset.row = -1; input.dataset.column = c; input.value = value; input.setAttribute('aria-label', `Column ${c + 1} header`);
        input.oninput = () => { table.headers[c] = input.value; changed(); };
        th.append(input); tr.append(th);
    });
    head.append(tr);
    const body = $('picks').querySelector('tbody'); body.replaceChildren();
    table.rows.forEach((row, r) => {
        const tr = document.createElement('tr');
        for (let c = 0; c < Math.max(row.length, table.headers.length); c++) {
            const td = document.createElement('td'), input = document.createElement('input');
            input.value = row[c] || ''; input.dataset.row = r; input.dataset.column = c;
            input.setAttribute('aria-label', `Player ${r + 1} ${table.headers[c] || 'extra column'}`);
            input.oninput = () => { row[c] = input.value; changed(); };
            td.append(input); tr.append(td);
        }
        const td = document.createElement('td'), remove = document.createElement('button');
        remove.textContent = 'Remove'; remove.setAttribute('aria-label', `Remove player ${r + 1}`);
        remove.onclick = () => { table.rows.splice(r, 1); changed(); render(); };
        td.append(remove);
        if (row.length !== table.headers.length) {
            const repair = document.createElement('button'); repair.textContent = 'Match columns';
            repair.onclick = () => {
                if (row.length > table.headers.length && !confirm('Remove extra values from this row?')) return;
                table.rows[r] = table.headers.map((_, c) => row[c] || ''); changed(); render();
            };
            td.append(repair);
        }
        tr.append(td); body.append(tr);
    });
    $('issues').replaceChildren();
    syncControls();
}
function showIssues(issues) {
    $('issues').replaceChildren();
    document.querySelectorAll('[aria-invalid], [data-warning]').forEach(el => { el.removeAttribute('aria-invalid'); el.removeAttribute('title'); el.removeAttribute('data-warning'); });
    for (const issue of issues) {
        const p = document.createElement('p'); p.className = issue.severity === 'error' ? 'text-pbj-danger' : 'text-pbj-warning';
        p.textContent = `${issue.severity}: ${issue.row < 0 ? 'Headers' : 'Player ' + (issue.row + 1)}, column ${issue.column + 1}: ${issue.message}`;
        $('issues').append(p);
        const cell = document.querySelector(`[data-row="${issue.row}"][data-column="${issue.column}"]`);
        if (cell) { cell.title = issue.message; if (issue.severity === 'warning') cell.dataset.warning = 'true'; if (issue.severity === 'error') cell.setAttribute('aria-invalid', 'true'); }
    }
}
function options(id, values, selected) {
    $(id).replaceChildren(...values.map(value => { const opt = document.createElement('option'); opt.value = value; opt.textContent = value; opt.selected = Number(value) === Number(selected); return opt; }));
}
async function open(next) {
    const result = await api(`/weeks/${next.season}/${next.week}`);
    selection = next; table = {headers: result.headers, rows: result.rows}; etag = result.etag;
    options('season', Object.keys(catalog.seasons), next.season);
    options('week', catalog.seasons[next.season], next.week);
    changed(false); render(); showIssues(result.issues); status(`Season ${next.season} · Week ${next.week}`);
}
function syncControls() {
    const ambiguous = Boolean(table.needsHeaderChoice);
    $('header-choice').hidden = !ambiguous;
    document.querySelectorAll('#editor button, #editor select, #editor input').forEach(el => {
        el.disabled = busy || (ambiguous && (el.closest('#picks') || ['headers', 'add', 'validate', 'save', 'submit'].includes(el.id)));
    });
}
async function task(fn) {
    if (busy) return;
    busy = true; syncControls();
    try { await fn(); } catch (error) { status(error.message); }
    finally { busy = false; syncControls(); }
}
async function validateTable() {
    const result = await api(path('validate'), 'POST', {csv: toCSV(table)});
    showIssues(result.issues);
}
async function upload(file) {
    if (!file || !canSwitch(dirty, confirm)) return;
    if (file.size > 250000) throw new Error('CSV exceeds 250 KB');
    table = parseCSV(await file.text()); changed(); render();
    if (table.needsHeaderChoice) { status('Choose whether the first row contains headers or player data.'); return; }
    await validateTable();
}
for (const choice of ['headers', 'players']) $('first-' + choice).onclick = () => task(async () => {
    if (!table.needsHeaderChoice) return;
    // Empty CSV validation already generates headers from the selected schedule.
    const schedule = choice === 'players' ? await api(path('validate'), 'POST', {csv: ''}) : null;
    table = resolveCSVHeaders(table, choice, schedule?.headers); changed(); render();
    await validateTable(); status('Upload interpreted; validation complete.');
});
$('login').onclick = () => beginLogin(config).catch(error => status(error.message));
$('logout').onclick = () => {
    if (!canSwitch(dirty, confirm)) return;
    token = null;
    const url = new URL('/logout', config.domain);
    url.search = new URLSearchParams({client_id: config.clientId, logout_uri: config.redirectUri}); location.assign(url);
};
for (const id of ['season', 'week']) $(id).onchange = () => task(async () => {
    const next = {season: Number($('season').value), week: Number($('week').value)};
    if (id === 'season') next.week = Math.max(...catalog.seasons[next.season]);
    if (!canSwitch(dirty, confirm)) { $('season').value = selection.season; $('week').value = selection.week; return; }
    try { await open(next); } catch (error) { $('season').value = selection.season; $('week').value = selection.week; throw error; }
});
$('reopen').onclick = () => task(async () => { if (canSwitch(dirty, confirm)) await open(selection); });
$('empty').onclick = () => task(async () => {
    if (!canSwitch(dirty, confirm)) return;
    const result = await api(path('validate'), 'POST', {csv: ''}); table = {headers: result.headers, rows: []}; changed(); render();
});
$('headers').onclick = () => task(async () => {
    if (!confirm('Restore schedule headers? Repair will stop if populated cells cannot be mapped safely.')) return;
    const result = await api(path('validate'), 'POST', {csv: ''});
    table = restoreHeaders(table, result.headers);
    changed(); render(); status('Schedule headers repaired.');
});
$('add').onclick = () => { table.rows.push(table.headers.map(() => '')); changed(); render(); };
$('file').onchange = () => task(() => upload($('file').files[0]));
$('drop').ondragover = event => event.preventDefault();
$('drop').ondrop = event => { event.preventDefault(); if (!busy) task(() => upload(event.dataTransfer.files[0])); };
$('validate').onclick = () => task(async () => { await validateTable(); status('Validation complete'); });
for (const action of ['save', 'submit']) $(action).onclick = () => task(async () => {
    if (action === 'submit' && !confirm('Submit these picks and publish processed results?')) return;
    status(action === 'save' ? 'Saving draft…' : 'Submitting and processing…');
    const result = await api(path(action === 'save' ? 'draft' : 'submit'), action === 'save' ? 'PUT' : 'POST', {csv: toCSV(table), etag, confirm: action === 'submit'});
    etag = result.etag; changed(false); showIssues(result.issues); status(action === 'save' ? 'Draft saved privately' : result.message);
});
window.addEventListener('beforeunload', event => { if (dirty || busy) { event.preventDefault(); event.returnValue = ''; } });
try {
    const res = await fetch('/assets/admin-config.json', {cache: 'no-store'});
    if (!res.ok) throw new Error('Portal configuration is not installed. See AWS setup instructions.');
    config = await res.json(); token = await finishLogin(config);
    if (token) {
        catalog = await api('/schedules');
        await open({season: catalog.season, week: catalog.week});
        $('editor').hidden = false; $('logout').hidden = false; $('login').textContent = 'Sign in again';
    }
} catch (error) { status(error.message); }
