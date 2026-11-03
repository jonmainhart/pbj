import {toCSV} from './admin-model.js';
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

export function createDraft({key, storage, etag, initial, read, write, erase, notify, delay = 3000, schedule = setTimeout, cancel = clearTimeout}) {
    const baseline = structuredClone(initial), originalEtag = etag;
    // A failed request may have reached S3; reconciliation must still be conditional.
    let needsReconcile = false;
    let table = structuredClone(initial), revision = 0, timer, pending, paused = false, blocked = false, disposed = false, localValue;
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
    function differsFromBaseline() {
        return Boolean(baseline) && (Boolean(table.needsHeaderChoice) !== Boolean(baseline.needsHeaderChoice) || toCSV(table) !== toCSV(baseline));
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
                needsReconcile = true;
                const result = await Promise.resolve().then(() => write(snapshot, etag));
                etag = result.etag; baseEtag = etag;
                needsReconcile = originalEtag === null || !baseline || toCSV(snapshot) !== toCSV(baseline);
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
    async function revert() {
        paused = true; cancel(timer);
        try {
            if (pending) await pending;
            if (needsReconcile && originalEtag === null && etag === null) {
                const current = await read();
                if (current.etag !== null) {
                    // This read proves existence, not ownership of an unconfirmed write.
                    etag = current.etag; blocked = true;
                    throw new Error('A saved draft exists. Use Reopen Saved Draft to review it; your device copy is preserved.');
                }
                needsReconcile = false; blocked = false;
            }
            if (blocked) throw new Error('Use Reopen Saved Draft before reverting; your device copy is preserved.');
            if (needsReconcile) {
                if (originalEtag !== null) etag = (await write(structuredClone(baseline), etag)).etag;
                else {
                    await erase(etag); etag = null;
                }
            }
            table = structuredClone(baseline); revision++; dirty = false; needsReconcile = false; baseEtag = etag;
            remove(); notify('saved', 'All changes saved');
            return structuredClone(baseline);
        } catch (error) {
            blocked = true; retain();
            notify('error', etag === null ? 'Revert failed; your work is preserved. Retry Revert Changes to check the server.' : 'Revert failed; your work is preserved. Reopen before saving.');
            throw error;
        }
    }
    return {
        get changed() {
            return needsReconcile || differsFromBaseline();
        },
        revert,
        async delete() {
            paused = true; blocked = true; cancel(timer);
            try {
                if (pending) await pending;
                await erase(etag);
                // Require a fresh session; a failed reload must not recreate the deleted draft.
                etag = null;
                notify('deleted');
            } catch (error) {
                retain(); notify('error', 'Draft deletion failed; your work is preserved. Reopen Saved Draft before saving.');
                throw error;
            }
        },
        get etag() { return etag; },
        get dirty() { return dirty; },
        get blocked() { return blocked; },
        get pending() { return pending; },
        edit(value) {
            table = structuredClone(value); revision++;
            dirty = !baseline || differsFromBaseline() || needsReconcile || Boolean(pending) || blocked || baseEtag !== etag;
            if (!dirty) { cancel(timer); remove(); notify('saved', 'All changes saved'); return; }
            notify('edited', blocked ? 'A newer draft exists — reopen and review before restoring.' : 'Unsaved changes');
            retain(); queue();
        },
        save,
        pause(value) { paused = value; cancel(timer); if (!value) queue(); },
        // Recovery never schedules a server write until the commissioner explicitly saves.
        recover(record) { paused = true; baseEtag = record.etag; table = structuredClone(record.table); revision++; dirty = true; retain(); notify('recovered', 'Device copy restored. Review it, then Save Draft.'); },
        discard() { storage.removeItem(key); },
        dispose() { disposed = true; cancel(timer); },
    };
}
