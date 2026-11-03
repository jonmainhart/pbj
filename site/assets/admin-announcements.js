import {renderAnnouncement} from './announcements.js';

export function announcementEditor(api) {
    const $ = id => document.getElementById(id);
    let baseline, etag, loading = false, conflict = false;
    const message = text => { $('announcements-status').textContent = text; };
    function documentValue() {
        return Object.fromEntries(['top', 'bottom'].map(position => {
            const label = $(position + '-label').value, url = $(position + '-url').value;
            return [position, {text:$(position + '-text').value, link:label || url ? {label, url} : null}];
        }));
    }
    const dirty = () => baseline !== undefined && JSON.stringify(documentValue()) !== baseline;
    function sync() {
        const value = documentValue();
        for (const position of ['top', 'bottom']) renderAnnouncement($('preview-' + position), value[position]);
        $('publish-announcements').disabled = loading || baseline === undefined || !dirty() || conflict;
        $('reload-announcements').hidden = baseline !== undefined && !conflict;
        $('reload-announcements').disabled = loading;
        document.querySelectorAll('#announcements-view input, #announcements-view textarea').forEach(el => { el.disabled = loading || baseline === undefined; });
    }
    async function load() {
        if (loading) return;
        loading = true; sync();
        try {
            const result = await api('/announcements');
            for (const position of ['top', 'bottom']) {
                $(position + '-text').value = result.document[position].text;
                $(position + '-label').value = result.document[position].link?.label || '';
                $(position + '-url').value = result.document[position].link?.url || '';
            }
            baseline = JSON.stringify(documentValue()); etag = result.etag; conflict = false;
            message('Published content loaded.');
        } catch (error) { message(error.message); }
        finally { loading = false; sync(); }
    }
    $('announcements-view').addEventListener('input', sync);
    $('reload-announcements').onclick = () => {
        if (dirty() && !confirm('Reload published content and discard your unsaved announcement edits?')) return;
        void load();
    };
    $('publish-announcements').onclick = async () => {
        if (loading || !dirty() || conflict) return;
        loading = true; sync();
        try {
            const result = await api('/announcements', 'PUT', {document:documentValue(), etag});
            baseline = JSON.stringify(result.document); etag = result.etag;
            message('Announcements published.');
        } catch (error) {
            conflict = error.status === 409;
            message(error.message + ' Your edits are preserved.' + (conflict ? ' Reload published content when ready to replace your edits.' : ''));
        } finally { loading = false; sync(); }
    };
    return {dirty, get busy() { return loading; }, open() { if (baseline === undefined) void load(); }};
}
