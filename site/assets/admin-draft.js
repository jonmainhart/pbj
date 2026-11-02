/** Local copies are recovery only. The ETag-protected private draft is authoritative. */
export function recoveryScope(config, user) {
    return 'pbj.draft.' + JSON.stringify([config.api, config.clientId, user]);
}
export function recoveryKey(scope, selection) { return `${scope}.${selection.season}.${selection.week}`; }
export function readRecovery(storage, key) {
    const value = JSON.parse(storage.getItem(key) || 'null');
    if (!value) return null;
    const strings = row => Array.isArray(row) && row.every(cell => typeof cell === 'string');
    if (value.version !== 1 || !strings(value.table?.headers) || !Array.isArray(value.table?.rows) ||
        !value.table.rows.every(strings) || !(value.etag === null || typeof value.etag === 'string')) {
        throw new Error('Device recovery copy could not be read. Keep this page open and save your work.');
    }
    return value;
}

export function createDraft({key, storage, etag, write, notify, delay = 3000, schedule = setTimeout, cancel = clearTimeout}) {
    let table, revision = 0, timer, pending, paused = false, blocked = false, disposed = false, localValue;
    let dirty = false, baseEtag = etag;
    function retain() {
        try {
            localValue = JSON.stringify({version:1, table, etag:baseEtag, updated:Date.now()});
            storage.setItem(key, localValue);
            return true;
        } catch { notify('storage', 'Device recovery is unavailable. Keep this page open until Save Draft succeeds.'); return false; }
    }
    function remove() {
        try { if (storage.getItem(key) === localValue) storage.removeItem(key); }
        catch { notify('storage', 'Unable to clear the device recovery copy.'); }
    }
    function queue() {
        cancel(timer);
        if (!disposed && !paused && !blocked && dirty) timer = schedule(() => { void save().catch(() => {}); }, delay);
    }
    async function save() {
        cancel(timer);
        if (pending) return pending;
        if (!dirty || disposed) return;
        if (blocked) throw new Error('A newer draft exists — reopen it and review your device copy before saving.');
        const savedRevision = revision, snapshot = structuredClone(table);
        pending = (async () => {
            try {
                const result = await Promise.resolve().then(() => write(snapshot, etag));
                etag = result.etag; baseEtag = etag;
                if (revision === savedRevision) { dirty = false; remove(); notify('saved', 'All changes saved'); }
                else { retain(); notify('edited', 'Unsaved changes'); }
                return result;
            } catch (error) {
                if (error.status === 409) blocked = true;
                const retained = retain();
                notify('error', error.status === 409 ? 'A newer draft exists — reopen and review before restoring.' :
                    retained ? 'Changes saved on this device; waiting to reconnect' : 'Changes are only on this page. Save Draft before leaving.');
                throw error;
            } finally {
                pending = null; notify('settled');
                // Only follow a successful save with another save for edits made in flight.
            }
        })();
        notify('saving', 'Saving…');
        const result = await pending; queue(); return result;
    }
    return {
        get etag() { return etag; },
        get dirty() { return dirty; },
        get blocked() { return blocked; },
        get pending() { return pending; },
        edit(value) { table = structuredClone(value); revision++; dirty = true; notify('edited', blocked ? 'A newer draft exists — reopen and review before restoring.' : 'Unsaved changes'); retain(); queue(); },
        save,
        pause(value) { paused = value; cancel(timer); if (!value) queue(); },
        // Recovery never schedules a server write until the commissioner explicitly saves.
        recover(record) { paused = true; baseEtag = record.etag; table = structuredClone(record.table); revision++; dirty = true; retain(); notify('recovered', 'Device copy restored. Review it, then Save Draft.'); },
        discard() { storage.removeItem(key); },
        dispose() { disposed = true; cancel(timer); },
    };
}
