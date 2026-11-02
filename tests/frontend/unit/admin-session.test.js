import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createSession, SessionExpired} from '../../../site/assets/admin-auth.js';
import {createDraft, recoveryScope, recoveryKey, readRecovery} from '../../../site/assets/admin-draft.js';
import {matchupFor, needsHeaderRepair} from '../../../site/assets/admin-model.js';
const config = {domain:'https://login.example', clientId:'spa', api:'https://api.example'};
const tokens = {access_token:'original', refresh_token:'refresh', expires_in:1800};
const response = (status, body = {}) => new Response(JSON.stringify(body), {status});
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return {promise, resolve}; };

test('refresh before expiry uses one request and retains refresh token only in memory', async () => {
    let now = 0, refreshes = 0;
    const gate = deferred(), seen = [];
    const session = createSession(config, tokens, {now:() => now, fetcher:async (url, options) => {
        if (String(url).includes('/oauth2/token')) {
            refreshes++; assert.equal(options.body.get('grant_type'), 'refresh_token');
            assert.equal(options.body.get('refresh_token'), 'refresh');
            await gate.promise; return response(200, {access_token:'renewed',expires_in:1800});
        }
        seen.push(options.headers.Authorization); return response(200);
    }});
    now = 1800000;
    const requests = [session.request('/one'), session.request('/two')];
    gate.resolve(); await Promise.all(requests);
    assert.equal(refreshes, 1); assert.deepEqual(seen, ['Bearer renewed','Bearer renewed']);
    now += 1800000; await session.request('/three'); assert.equal(refreshes, 2);
    session.clear(); await assert.rejects(session.request('/four'), SessionExpired);
});
test('simultaneous rejected JWTs share renewal and replay each request at most once', async () => {
    let refreshes = 0;
    const calls = [];
    const session = createSession(config, tokens, {fetcher:async (url, options) => {
        if (String(url).includes('/oauth2/token')) { refreshes++; return response(200, {access_token:'renewed',expires_in:1800}); }
        calls.push(options.headers.Authorization);
        return response(options.headers.Authorization.endsWith('original') ? 401 : 200);
    }});
    await Promise.all([session.request('/one'), session.request('/two')]);
    assert.equal(refreshes, 1); assert.equal(calls.length, 4);
});
test('failed refresh expires session without leaking credential response details', async () => {
    let calls = 0;
    const session = createSession(config, tokens, {fetcher:async url => {
        calls++; return String(url).includes('/oauth2/token') ? response(400, {error_description:'secret'}) : response(401);
    }});
    await assert.rejects(session.request('/one'), error => error instanceof SessionExpired && !error.message.includes('secret'));
    await assert.rejects(session.request('/two'), SessionExpired); assert.equal(calls, 2);
});
test('network and server failures never replay a submission; forbidden identity fails closed', async () => {
    for (const failure of ['network', 502, 403]) {
        let calls = 0;
        const session = createSession(config, tokens, {fetcher:async () => {
            calls++; if (failure === 'network') throw new TypeError('offline'); return response(failure);
        }});
        try { await session.request('/submit', {method:'POST'}); } catch { /* Expected failure. */ }
        assert.equal(calls, 1);
        if (failure === 403) await assert.rejects(session.request('/one'), SessionExpired);
    }
});
function draftHarness(write) {
    const data = new Map(), events = [];
    const storage = {getItem:k => data.get(k) ?? null, setItem:(k,v) => data.set(k,v), removeItem:k => data.delete(k)};
    let callback;
    const draft = createDraft({key:'draft',storage,etag:'base',write,notify:(...event) => events.push(event),schedule:fn => { callback = fn; },cancel:() => { callback = null; }});
    return {draft, data, events, storage, tick:() => callback?.()};
}
const table = {headers:['NAME','NE SEA','TIEBREAKER'],rows:[['Alice','','']]};
test('debounced saves serialize writes and retain edits made while a write is pending', async () => {
    const gate = deferred(), writes = [];
    const h = draftHarness(async (value, etag) => { writes.push({value, etag}); if (writes.length === 1) await gate.promise; return {etag:'version' + writes.length}; });
    h.draft.edit(table); h.tick();
    await Promise.resolve();
    const pending = h.draft.pending;
    const next = structuredClone(table); next.rows[0][1] = 'SEA'; h.draft.edit(next);
    h.tick(); assert.equal(writes.length, 1);
    gate.resolve(); await pending;
    // Flush the successful completion's queued next save.
    await Promise.resolve(); h.tick(); await h.draft.pending;
    assert.equal(writes.length, 2); assert.equal(writes[1].etag, 'version1');
    assert.equal(writes[1].value.rows[0][1], 'SEA'); assert.equal(h.draft.dirty, false); assert.equal(h.data.size, 0);
});
test('offline and conflict saves preserve exact partial data and never advance ETags on failure', async () => {
    for (const status of [0,409]) {
        let calls = 0;
        const h = draftHarness(async () => { calls++; throw Object.assign(new Error('failed'), {status}); });
        h.draft.edit(table); await assert.rejects(h.draft.save());
        assert.equal(h.draft.etag, 'base'); assert.equal(h.draft.dirty, true);
        assert.deepEqual(readRecovery(h.storage, 'draft').table, table);
        h.tick(); assert.equal(calls, 1);
        if (status === 409) await assert.rejects(h.draft.save(), /newer draft/);
    }
});
test('recovery requires deliberate saving and keys isolate users, services and weeks', async () => {
    let calls = 0;
    const h = draftHarness(async () => { calls++; return {etag:'saved'}; });
    h.draft.recover({table,etag:'base'}); h.tick(); assert.equal(calls, 0);
    await h.draft.save(); assert.equal(calls, 1);
    assert.notEqual(recoveryScope(config,'alice'), recoveryScope(config,'bob'));
    assert.notEqual(recoveryScope(config,'alice'), recoveryScope({...config,api:'other'},'alice'));
    assert.notEqual(recoveryKey('scope',{season:2026,week:1}), recoveryKey('scope',{season:2026,week:2}));
});
test('storage failure is reported and successful server save still works', async () => {
    const events = [];
    const draft = createDraft({key:'key',etag:null,storage:{setItem:() => { throw Error('quota'); },getItem:() => null},write:async () => ({etag:'saved'}),notify:(...args) => events.push(args)});
    draft.edit(table); assert.ok(events.some(([state]) => state === 'storage'));
    await draft.save(); assert.equal(draft.dirty, false); draft.dispose();
});
test('schedule objects determine orientation while accepted aliases and reversals need no repair', () => {
    const games = [{id:'a',away:'JAX',home:'WSH'}], expected = ['NAME','JAX WSH','TIEBREAKER'];
    for (const header of ['WSH JAX','WAS JAC',' jac was ']) {
        const headers = ['NAME',header,'TIEBREAKER'];
        assert.deepEqual(matchupFor(header, headers, games), games[0]);
        assert.equal(needsHeaderRepair({headers,rows:[['Alice','WAS','30','extra']]}, expected), false);
    }
    const headers = ['NAME','JAC WAS','WSH JAX','TIEBREAKER'];
    assert.equal(matchupFor('JAC WAS', headers, games), null);
    assert.equal(needsHeaderRepair({headers,rows:[]}, expected), true);
    assert.equal(needsHeaderRepair({headers,rows:[],needsHeaderChoice:true}, expected), false);
});

test('reserved CSV headers still require canonical case and a leading NAME', () => {
    const expected = ['NAME','NE SEA','TIEBREAKER'];
    for (const headers of [['name','NE SEA','TIEBREAKER'], ['NAME','NE SEA','tiebreaker'], ['NE SEA','NAME','TIEBREAKER']]) {
        assert.equal(needsHeaderRepair({headers,rows:[]},expected), true);
    }
});


for (const original of ['old', 'base', null]) {
    test(`recovery retains ${original} provenance across edits and reload until a confirmed write`, async () => {
        const writes = [], h = draftHarness(async (value, etag) => { writes.push({value,etag}); return {etag:'resolved'}; });
        h.draft.recover({table,etag:original});
        assert.equal(h.draft.etag, 'base');
        assert.equal(readRecovery(h.storage,'draft').etag, original);
        const edited = structuredClone(table); edited.rows[0][2] = '42';
        h.draft.edit(edited); h.tick(); assert.equal(writes.length,0);
        const record = readRecovery(h.storage,'draft');
        const reloaded = createDraft({key:'draft',storage:h.storage,etag:'latest',write:async (value,etag) => {
            writes.push({value,etag}); return {etag:'resolved'};
        },notify:() => {}});
        reloaded.recover(record);
        assert.equal(readRecovery(h.storage,'draft').etag,original);
        await reloaded.save();
        assert.equal(writes[0].etag,'latest');
        assert.deepEqual(writes[0].value,edited);
        assert.equal(h.data.size,0);
        reloaded.edit(edited);
        assert.equal(readRecovery(h.storage,'draft').etag,'resolved');
        reloaded.dispose(); h.draft.dispose();
    });
}
for (const status of [0,409,502]) {
    test(`failed recovered save (${status}) retains old provenance and current conditional version`, async () => {
        let written;
        const h = draftHarness(async (_,etag) => { written = etag; throw Object.assign(new Error('failed'),{status}); });
        h.draft.recover({table,etag:'old'});
        await assert.rejects(h.draft.save());
        assert.equal(written,'base'); assert.equal(h.draft.etag,'base');
        assert.equal(h.draft.dirty,true);
        assert.equal(readRecovery(h.storage,'draft').etag,'old');
        assert.deepEqual(readRecovery(h.storage,'draft').table,table);
        assert.equal(Boolean(h.draft.pending),false);
        h.draft.dispose();
    });
}
test('clean saves do not write or announce persistence', async () => {
    const h = draftHarness(() => { throw Error('unexpected write'); });
    assert.equal(await h.draft.save(),undefined);
    assert.deepEqual(h.events,[]);
});
