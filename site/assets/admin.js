import {parseCSV, toCSV, canSwitch, restoreHeaders, resolveCSVHeaders, matchupFor, needsHeaderRepair} from './admin-model.js';
import {beginLogin, finishLogin, createSession, SessionExpired} from './admin-auth.js';
import {createDraft, readRecovery, recoveryScope, recoveryKey} from './admin-draft.js';
const device = {getItem:key => localStorage.getItem(key), setItem:(key, value) => localStorage.setItem(key, value), removeItem:key => localStorage.removeItem(key)};
const $ = id => document.getElementById(id);
let intentionalNavigation = false;
let expectedHeaders = [], games = [], drafts, scope, recovery, recoveryReview = false;
let config, session, catalog, selection, table = {headers: [], rows: []}, dirty = false, busy = false;
const status = text => { $('status').textContent = text; };
function changed(value = true) {
    dirty = value;
    if (value) { drafts?.edit(table); drafts?.pause(busy || recoveryReview || Boolean(table.needsHeaderChoice)); }
    else $('dirty').textContent = 'All changes saved';
}
function sessionExpired() {
    $('login').hidden = false; $('login').textContent = 'Sign in to continue';
    $('logout').hidden = true;
    status('Session expired — sign in to continue. Your edits are still here.');
}
async function api(path, method = 'GET', body) {
    let res;
    try {
        res = await session.request(config.api + path, {method, cache:'no-store',
            headers: body ? {'Content-Type':'application/json'} : {}, ...(body ? {body:JSON.stringify(body)} : {})});
    } catch (error) {
        if (error instanceof SessionExpired) sessionExpired();
        throw error;
    }
    const result = await res.json();
    if (!res.ok) {
        if (result.issues) showIssues(result.issues);
        const error = new Error(result.message || 'Request failed');
        error.status = res.status;
        throw error;
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
        const label = document.createElement('span');
        const present = () => {
            const game = matchupFor(input.value, table.headers, games);
            label.textContent = game ? `${game.away}\n${game.home}` : input.value || 'Edit header';
            input.setAttribute('aria-description', game ? `${game.away} away at ${game.home} home. Edit CSV header.` : 'Edit CSV header');
        };
        label.className = 'block whitespace-pre text-center px-2 py-1'; label.setAttribute('aria-hidden', 'true'); present();
        th.className = 'header-cell';
        input.title = 'Edit column header'; input.addEventListener('headerdisplay', present);
        input.oninput = () => { table.headers[c] = input.value; head.querySelectorAll('input').forEach(el => el.dispatchEvent(new Event('headerdisplay'))); changed(); syncControls(); };
        const editor = document.createElement('div'); editor.className = 'header-editor';
        editor.append(label, input); th.append(editor); tr.append(th);
    });
    head.append(tr);
    const body = $('picks').querySelector('tbody'); body.replaceChildren();
    function appendRow(row, r, entry = false) {
        const tr = document.createElement('tr');
        for (let c = 0; c < Math.max(row.length, table.headers.length); c++) {
            const td = document.createElement('td'), input = document.createElement('input');
            input.value = row[c] || ''; input.dataset.row = r; input.dataset.column = c;
            input.setAttribute('aria-label', `Player ${r + 1} ${table.headers[c] || 'extra column'}`);
            input.oninput = () => {
                row[c] = input.value;
                if (entry) {
                    entry = false; table.rows.push(row); remove.hidden = false;
                    appendRow(table.headers.map(() => ''), table.rows.length, true);
                }
                if (!entry && r === table.rows.length - 1 && row.every(value => value === '')) {
                    table.rows.pop(); body.lastElementChild.remove(); entry = true; remove.hidden = true;
                }
                changed(); syncControls();
            };
            td.append(input); tr.append(td);
        }
        const td = document.createElement('td'), remove = document.createElement('button');
        remove.hidden = entry; remove.textContent = 'Remove'; remove.setAttribute('aria-label', `Remove player ${r + 1}`);
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
    }
    table.rows.forEach((row, r) => appendRow(row, r));
    if (!table.needsHeaderChoice && table.headers.length) appendRow(table.headers.map(() => ''), table.rows.length, true);
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
    games = result.games;
    if (!Array.isArray(games)) throw new Error('Portal API needs schedule metadata. Reload after the API is updated.');
    expectedHeaders = ['NAME', ...games.map(g => `${g.away} ${g.home}`), 'TIEBREAKER'];
    drafts?.dispose();
    selection = next; table = {headers: result.headers, rows: result.rows};
    recoveryReview = false;
    const key = recoveryKey(scope, selection);
    drafts = createDraft({key, storage:device, etag:result.etag,
        write: (value, etag) => api(path('draft'), 'PUT', {csv:toCSV(value), etag}),
        notify: (state, text) => {
            if (state === 'storage') { $('recovery-status').textContent = text; return; }
            dirty = drafts?.dirty ?? false;
            if (text) $('dirty').textContent = (recoveryReview && dirty && recovery?.etag !== drafts.etag ? 'A newer server draft exists — review before saving. ' : '') + text;
            syncControls();
        },
    });
    recovery = null;
    try { device.setItem(scope + '.selection', JSON.stringify(selection)); }
    catch { $('recovery-status').textContent = 'Device recovery cannot be updated. Keep this page open until Save Draft succeeds.'; }
    try {
        recovery = readRecovery(device, key);
        if (recovery && recovery.etag === result.etag && !recovery.table.needsHeaderChoice && toCSV(recovery.table) === toCSV(table)) {
            device.removeItem(key); recovery = null;
        }
    } catch { $('recovery-status').textContent = 'Device recovery is unavailable or unreadable. Keep this page open until Save Draft succeeds.'; }
    $('recovery').hidden = !recovery;
    $('recovery-message').textContent = recovery?.etag !== result.etag ? 'A newer draft exists — review before restoring your device copy.' : 'Unsaved work is available on this device.';
    options('season', Object.keys(catalog.seasons), next.season);
    options('week', catalog.seasons[next.season], next.week);
    changed(false); render(); showIssues(result.issues); status(`Season ${next.season} · Week ${next.week}`);
}

function syncControls() {
    const ambiguous = Boolean(table.needsHeaderChoice);
    $('header-choice').hidden = !ambiguous;
    $('headers').hidden = !needsHeaderRepair(table, expectedHeaders);
    document.querySelectorAll('#editor button, #editor select, #editor input').forEach(el => {
        el.disabled = busy || (!$('recovery').hidden && !['restore-device', 'discard-device', 'season', 'week', 'reopen'].includes(el.id)) || (ambiguous && (el.closest('#picks') || ['headers', 'validate', 'save', 'submit'].includes(el.id)));
    });
    $('save').disabled ||= !drafts?.dirty || Boolean(drafts?.pending) || Boolean(drafts?.blocked);
}
async function task(fn) {
    if (busy) return;
    busy = true; drafts?.pause(true); syncControls();
    try { await drafts?.pending?.catch(() => {}); await fn(); } catch (error) { status(error.message); }
    finally { busy = false; drafts?.pause(recoveryReview || Boolean(table.needsHeaderChoice)); syncControls(); }
}
async function validateTable() {
    const result = await api(path('validate'), 'POST', {csv: toCSV(table)});
    showIssues(result.issues);
}
async function upload(file) {
    if (!$('recovery').hidden) { status('Restore or discard the device copy before uploading another CSV.'); return; }
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
$('restore-device').onclick = () => {
    if (!recovery) return;
    table = structuredClone(recovery.table); recoveryReview = true;
    drafts.recover(recovery); dirty = true; $('recovery').hidden = true; render();
    status((recovery.etag !== drafts.etag ? 'A newer server draft exists. ' : '') + 'Device copy restored. Review it, then Save Draft. Nothing has been overwritten.');
};
$('discard-device').onclick = () => {
    try { drafts.discard(); recovery = null; $('recovery').hidden = true; syncControls(); }
    catch { $('recovery-status').textContent = 'Unable to discard the device copy. Browser storage is unavailable.'; }
};
$('login').onclick = () => {
    if (dirty) {
        drafts.edit(table); drafts.pause(true);
        if ($('recovery-status').textContent && !confirm('Device recovery may be unavailable. Copy your work before continuing to sign in. Continue?')) return;
    }
    intentionalNavigation = true;
    beginLogin(config).catch(error => { intentionalNavigation = false; status(error.message); });
};
$('logout').onclick = () => task(async () => {
    if (dirty && !confirm('Sign out with unsaved work? A recovery copy will remain on this device for this account, if browser storage is available.')) return;
    drafts?.dispose(); session.clear();
    $('editor').hidden = true; $('recovery').hidden = true;
    const url = new URL('/logout', config.domain);
    url.search = new URLSearchParams({client_id: config.clientId, logout_uri: config.redirectUri});
    // Deliberate navigation after the recovery copy has been retained.
    dirty = false; busy = false; location.assign(url);
});
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
$('file').onchange = () => task(() => upload($('file').files[0]));
$('drop').ondragover = event => event.preventDefault();
$('drop').ondrop = event => { event.preventDefault(); if (!busy) task(() => upload(event.dataTransfer.files[0])); };
$('validate').onclick = () => task(async () => { await validateTable(); status('Validation complete'); });
$('save').onclick = () => task(async () => {
    if (drafts.blocked) throw new Error('Draft changed in another session. Reopen before saving.');
    if (recoveryReview && !confirm('Replace the currently opened server draft with this reviewed device copy?')) return;
    const result = await drafts.save();
    if (!result) return;
    recoveryReview = false;
    dirty = drafts.dirty;
    if (result) showIssues(result.issues);
    status('Draft saved privately');
});
$('submit').onclick = () => task(async () => {
    if (recoveryReview || drafts.blocked) throw new Error('Review and Save Draft before submitting recovered work.');
    if (!confirm('Submit these picks and publish processed results?')) return;
    // Save separately first. Submission is never automatically retried after an uncertain outcome.
    await drafts.save();
    status('Submitting and processing…');
    const result = await api(path('submit'), 'POST', {csv:toCSV(table), etag:drafts.etag, confirm:true});
    showIssues(result.issues); status(result.message);
    // Submission also writes the draft; reload its authoritative ETag before further editing.
    await open(selection); status(result.message);
});
window.addEventListener('online', () => { if (dirty && !busy && !recoveryReview) void drafts?.save().catch(() => {}); });
window.addEventListener('beforeunload', event => { if (!intentionalNavigation && (dirty || busy)) { event.preventDefault(); event.returnValue = ''; } });
try {
    const res = await fetch('/assets/admin-config.json', {cache: 'no-store'});
    if (!res.ok) throw new Error('Portal configuration is not installed. See AWS setup instructions.');
    config = await res.json(); const tokens = await finishLogin(config);
    if (tokens) {
        session = createSession(config, tokens);
        catalog = await api('/schedules');
        if (typeof catalog.user_id !== 'string' || !catalog.user_id) throw new Error('Commissioner identity could not be verified.');
        scope = recoveryScope(config, catalog.user_id);
        let next = {season:catalog.season, week:catalog.week};
        try {
            const saved = JSON.parse(device.getItem(scope + '.selection') || 'null');
            if (saved && catalog.seasons[saved.season]?.includes(saved.week)) next = saved;
        } catch { $('recovery-status').textContent = 'Device recovery is unavailable. Keep this page open until Save Draft succeeds.'; }
        await open(next);
        $('editor').hidden = false; $('logout').hidden = false; $('login').hidden = true;
    }
} catch (error) { status(error.message); }
