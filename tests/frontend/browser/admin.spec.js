import {test, expect} from '@playwright/test';

async function authenticated(page, {user = 'commissioner', etag = null, rows = [], published = false, selected, unpublished = false, games, headers, waitForReady = true, intercept = (_route, next) => next()} = {}) {
    await page.route('**/assets/admin-config.json', route => route.fulfill({json:{api:'https://admin.example',domain:'https://login.example',clientId:'spa',redirectUri:'http://127.0.0.1:8000/admin/'}}));
    await page.route('https://login.example/oauth2/token', route => intercept(route, () => route.fulfill({json:{access_token:'test-access',refresh_token:'test-refresh',expires_in:1800}})));
    await page.route('https://admin.example/**', route => intercept(route, () => {
        expect(route.request().headers().authorization).toBe('Bearer test-access');
        const path = new URL(route.request().url()).pathname;
        if (path === '/schedules') return route.fulfill({json:{seasons:{2026:[1,2,3]},season:2026,week:2,user_id:user}});
        if (path.endsWith('/3') && !unpublished) return route.fulfill({status:404,json:{message:'No schedule available for the selected week'}});
        if (path.endsWith('/draft')) return route.fulfill({json:{etag:'saved',issues:[]}});
        if (path.endsWith('/submit')) return route.fulfill({json:{etag:'submitted',issues:[],message:'Picks submitted and processed',result:{status:'ok'}}});
        return route.fulfill({json:{games:games || [{id:'game',away:path.includes('/1')?'JAX':'NE',home:path.includes('/1')?'WSH':'SEA'}],headers:headers || ['NAME',path.includes('/1')?'JAX WSH':'NE SEA','TIEBREAKER'], rows, etag, published, source:etag ? 'draft' : published ? 'published' : 'empty', issues:[]}});
    }));
    if (selected) await page.addInitScript(value => localStorage.setItem('pbj.draft.' + JSON.stringify(['https://admin.example','spa','commissioner']) + '.selection', JSON.stringify(value)), selected);
    await page.addInitScript(() => sessionStorage.setItem('pbj.pkce', JSON.stringify({verifier:'verifier',state:'state',created:Date.now()})));
    await page.goto('/admin/?code=code&state=state');
    if (waitForReady) await expect(page.locator('#editor')).toBeVisible();
}
test('public shell requires sign-in', {tag:'@smoke'}, async ({page}) => {
    await page.route('**/assets/admin-config.json', route => route.fulfill({json:{}}));
    await page.goto('/admin/');
    await expect(page.locator('#editor')).toBeHidden();
    await expect(page.getByRole('button',{name:'Sign in',exact:true})).toBeVisible();
    await expect(page.locator('#login')).toBeEnabled();
    await expect(page.locator('#status')).toHaveText('Sign in with your commissioner account to begin.');
});
test('current default, editing, draft save and schedule switching', {tag:'@smoke'}, async ({page}) => {
    await authenticated(page);
    await expect(page.locator('#save')).toBeDisabled();
    await expect(page.locator('#week')).toHaveValue('2');
    await expect(page.getByLabel('Column 2 header')).toHaveValue('NE SEA');
    await page.getByLabel('Player 1 NAME',{exact:true}).fill('Alice');
    page.once('dialog', dialog => dialog.dismiss());
    await page.locator('#week').selectOption('1');
    await expect(page.locator('#week')).toHaveValue('2');
    await page.getByRole('button',{name:'Save Draft',exact:true}).click();
    await expect(page.locator('#status')).toHaveText('Draft saved privately');
    await expect(page.locator('#save')).toBeDisabled();
    await page.locator('#week').selectOption('1');
    await expect(page.getByLabel('Column 2 header')).toHaveValue('JAX WSH');
    await expect(page.locator('#picks tbody tr')).toHaveCount(1);
    await page.locator('#week').selectOption('3');
    await expect(page.locator('#status')).toContainText('No schedule');
    await expect(page.locator('#week')).toHaveValue('1');
});
test('CSV upload is editable and submit requires confirmation', {tag:'@smoke'}, async ({page}) => {
    await authenticated(page);
    await page.locator('#file').setInputFiles({name:'picks.csv',mimeType:'text/csv',buffer:Buffer.from('NAME,NE SEA,TIEBREAKER\nAlice,SEA,30\n')});
    await expect(page.getByLabel('Player 1 NAME',{exact:true})).toHaveValue('Alice');
    page.once('dialog', dialog => dialog.accept());
    await page.getByRole('button',{name:'Submit Picks',exact:true}).click();
    await expect(page.locator('#status')).toHaveText('Picks submitted and processed');
});
test('PKCE callback rejects mismatched state', async ({page}) => {
    await page.route('**/assets/admin-config.json', route => route.fulfill({json:{domain:'https://login.example'}}));
    await page.goto('/admin/?code=stolen&state=invalid');
    await expect(page.locator('#status')).toContainText('Invalid or expired login state');
    await expect(page.getByRole('button', {name:'Sign in',exact:true})).toBeEnabled();
    await expect(page.locator('#editor')).toBeHidden();
});
test('mobile editor keeps wide picks table inside a scroll region', async ({page}) => {
    await page.setViewportSize({width:390,height:844});
    await authenticated(page);
    await expect(page.getByLabel('Player 1 NAME',{exact:true})).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
test('cell diagnostics clear after correction and conflicts preserve edits', async ({page}) => {
    await authenticated(page);
    await page.route('https://admin.example/**/validate', route => {
        const csv = route.request().postDataJSON().csv;
        return route.fulfill({json:{issues:csv.includes('Alice') ? [] : [{row:0,column:0,severity:'error',message:'Missing player name'}]}});
    });
    await page.locator('#validate').click();
    await expect(page.getByLabel('Player 1 NAME',{exact:true})).toHaveAttribute('aria-invalid','true');
    await page.getByLabel('Player 1 NAME',{exact:true}).fill('Alice');
    await page.locator('#validate').click();
    await expect(page.getByLabel('Player 1 NAME',{exact:true})).not.toHaveAttribute('aria-invalid');
    await page.route('https://admin.example/**/draft', route => route.fulfill({status:409,json:{message:'Draft changed in another session. Reopen before saving.'}}));
    await page.locator('#save').click();
    await expect(page.locator('#status')).toContainText('Draft changed');
    await expect(page.getByLabel('Player 1 NAME',{exact:true})).toHaveValue('Alice');
    await expect(page.locator('#dirty')).toContainText('A newer draft exists');
});
test('sign-in starts authorization code flow with S256 PKCE', async ({page}) => {
    await page.route('**/assets/admin-config.json', route => route.fulfill({json:{domain:'https://login.example',clientId:'spa',redirectUri:'http://127.0.0.1:8000/admin/'}}));
    await page.route('https://login.example/**', route => route.fulfill({body:'Managed login'}));
    await page.goto('/admin/');
    await expect(page.locator('#status')).toContainText('Sign in with');
    await page.locator('#login').click();
    await page.waitForURL('https://login.example/**');
    const params = new URL(page.url()).searchParams;
    expect(params.get('response_type')).toBe('code');
    expect(params.get('code_challenge_method')).toBe('S256');
    expect(params.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(params.get('state')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(params.get('scope')).toBe('openid pbj/admin');
});
for (const header of ['', 'PLAYER', 'NAEM']) {
    test(`CSV upload with ${header ? 'incorrect ' + header : 'missing'} NAME header stays editable and reaches backend validation`, async ({page}) => {
        await authenticated(page);
        const uploadedCSV = `"${header}","NE SEA","TIEBREAKER"\r\n"Alice","SEA","30","extra"\r\n"Bob","NE"\r\n`;
        const validated = [];
        await page.route('https://admin.example/**/validate', route => {
            const csv = route.request().postDataJSON().csv;
            validated.push(csv);
            return route.fulfill({json:{issues:csv.startsWith('"NAME",') ? [] : [
                {row:-1,column:0,severity:'error',message:'CSV is missing NAME header row'},
            ]}});
        });
        await page.locator('#file').setInputFiles({name:'malformed.csv',mimeType:'text/csv',buffer:Buffer.from(uploadedCSV)});
        await expect(page.locator('#header-choice')).toBeVisible();
        await expect(page.locator('#headers')).toBeDisabled();
        expect(validated).toEqual([]);
        await page.getByRole('button', {name:'First row contains headers',exact:true}).click();
        const firstHeader = page.getByLabel('Column 1 header');
        await expect(firstHeader).toHaveValue(header);
        await expect(firstHeader).toHaveAttribute('aria-invalid','true');
        await expect(page.locator('#issues')).toContainText('CSV is missing NAME header row');
        await expect(page.locator('#picks tbody tr')).toHaveCount(3);
        await expect(page.locator('[data-row="0"][data-column="0"]')).toHaveValue('Alice');
        await expect(page.locator('[data-row="0"][data-column="3"]')).toHaveValue('extra');
        await expect(page.locator('[data-row="1"][data-column="0"]')).toHaveValue('Bob');
        expect(validated).toEqual([uploadedCSV]);
        await firstHeader.fill('NAME');
        await page.locator('#validate').click();
        await expect(firstHeader).not.toHaveAttribute('aria-invalid');
        expect(validated[1]).toBe(uploadedCSV.replace(`"${header}",`, '"NAME",'));
        await expect(page.locator('#dirty')).toHaveText('Unsaved changes');
    });
}
for (const csv of ['Alice,JAX,30\n', 'Alice,JAX,30,extra\nBob,WSH\n']) {
    test(`headerless ${csv.includes('Bob') ? 'malformed multi-player' : 'single-player'} upload keeps first player through interpretation, editing and repair`, async ({page}) => {
        await authenticated(page);
        await page.locator('#week').selectOption('1');
        await expect(page.locator('#status')).toHaveText('Season 2026 · Week 1');
        const validated = [];
        await page.route('https://admin.example/**/validate', route => {
            expect(new URL(route.request().url()).pathname).toBe('/weeks/2026/1/validate');
            const text = route.request().postDataJSON().csv;
            validated.push(text);
            return route.fulfill({json:{headers:['NAME','JAX WSH','TIEBREAKER'], rows:[], issues:
                text.includes('extra') ? [{row:0,column:0,severity:'error',message:'Malformed row: column count differs from header'}] : []}});
        });
        await page.locator('#file').setInputFiles({name:'headerless.csv',mimeType:'text/csv',buffer:Buffer.from(csv)});
        await expect(page.locator('#header-choice')).toBeVisible();
        for (const id of ['headers', 'validate', 'save', 'submit']) await expect(page.locator('#' + id)).toBeDisabled();
        await expect(page.locator('[data-row="0"][data-column="0"]')).toHaveValue('Alice');
        expect(validated).toEqual([]);
        await page.getByRole('button', {name:'First row contains player data',exact:true}).click();
        await expect(page.locator('#header-choice')).toBeHidden();
        await expect(page.locator('#status')).toHaveText('Upload interpreted; validation complete.');
        await expect(page.getByLabel('Column 2 header')).toHaveValue('JAX WSH');
        const firstName = page.locator('[data-row="0"][data-column="0"]');
        const firstPick = page.locator('[data-row="0"][data-column="1"]');
        const tiebreaker = page.locator('[data-row="0"][data-column="2"]');
        await expect(firstName).toHaveValue('Alice');
        await expect(firstPick).toHaveValue('JAX');
        await expect(tiebreaker).toHaveValue('30');
        const serializedRows = csv.trimEnd().split('\n').map(row => row.split(',').map(c => `"${c}"`).join(',')).join('\r\n');
        expect(validated).toEqual(['', '"NAME","JAX WSH","TIEBREAKER"\r\n' + serializedRows + '\r\n']);
        if (csv.includes('extra')) {
            await expect(page.locator('#issues')).toContainText('Malformed row');
            await expect(firstName).toHaveAttribute('aria-invalid','true');
            await expect(page.locator('[data-row="0"][data-column="3"]')).toHaveValue('extra');
            await expect(page.locator('[data-row="1"][data-column="0"]')).toHaveValue('Bob');
        }
        await tiebreaker.fill('42');
        await page.locator('#validate').click();
        await expect(page.locator('#status')).toHaveText('Validation complete');
        expect(validated[2]).toContain('"Alice","JAX","42"');
        await page.getByLabel('Column 2 header').fill('WSH JAX');
        await expect(page.locator('#headers')).toBeHidden();
        await expect(firstName).toHaveValue('Alice');
        await expect(firstPick).toHaveValue('JAX');
        await expect(tiebreaker).toHaveValue('42');
    });
}
for (const [label, csv, message, correction] of [
    ['PLAYER', 'PLAYER,NE SEA,TIEBREAKER\nAlice,SEA,30\n', 'column 1 ("PLAYER")', [0,'NAME']],
    ['misspelled NAME', 'NAEM,NE SEA,TIEBREAKER\nAlice,SEA,30\n', 'column 1 ("NAEM")', [0,'NAME']],
    ['unknown column', 'NAME,NE SEA,NOTES\nAlice,SEA,30\n', 'column 3 ("NOTES")', [2,'TIEBREAKER']],
    ['duplicate matchup', 'NAME,NE SEA,SEA NE,TIEBREAKER\nAlice,SEA,NE,30\n', 'Columns 2, 3', null],
    ['alias collision', 'NAME,JAC WAS,WSH JAX,TIEBREAKER\nAlice,JAC,WSH,30\n', 'Columns 2, 3', null],
    ['extra cell', 'NAME,NE SEA,TIEBREAKER,NOTES\nAlice,SEA,30,keep me\n', 'has data with no matching schedule header', null],
]) {
    test(`header repair rejects ${label} without data loss${correction ? ' and succeeds after manual correction' : ''}`, async ({page}) => {
        await authenticated(page);
        const target = label === 'alias collision' ? 'JAX WSH' : 'NE SEA';
        await page.route('https://admin.example/**/validate', route => route.fulfill({json:{headers:['NAME',target,'TIEBREAKER'],issues:[]}}));
        await page.locator('#file').setInputFiles({name:'repair.csv',mimeType:'text/csv',buffer:Buffer.from(csv)});
        if (['PLAYER','misspelled NAME'].includes(label)) await page.locator('#first-headers').click();
        await expect(page.locator('#headers')).toBeEnabled();
        const values = () => page.locator('#picks input').evaluateAll(inputs => inputs.map(input => input.value));
        const original = await values();
        page.once('dialog', dialog => dialog.accept());
        await page.locator('#headers').click();
        await expect(page.locator('#status')).toContainText('Header repair stopped; no data changed');
        await expect(page.locator('#status')).toContainText(message);
        await expect(page.locator('#status')).toContainText('then retry');
        expect(await values()).toEqual(original);
        await expect(page.locator('#dirty')).toHaveText('Unsaved changes');
        if (correction) {
            await page.getByLabel(`Column ${correction[0] + 1} header`).fill(correction[1]);
            await page.getByLabel('Column 2 header').fill('SEA NE');
            await expect(page.locator('#headers')).toBeHidden();
            expect(await values()).toEqual(['NAME','SEA NE','TIEBREAKER','Alice','SEA','30','','','']);
        }
    });
}
test('header repair drops only empty unmatched columns', async ({page}) => {
    await authenticated(page);
    await page.locator('#file').setInputFiles({name:'empty-extra.csv',mimeType:'text/csv',buffer:Buffer.from('NAME,NE SEA,TIEBREAKER,NOTES\nAlice,SEA,30,,\n')});
    await expect(page.getByLabel('Column 4 header')).toHaveValue('NOTES');
    page.once('dialog', dialog => dialog.accept());
    await page.locator('#headers').click();
    await expect(page.locator('#picks thead input')).toHaveCount(3);
    expect(await page.locator('#picks tbody input').evaluateAll(inputs => inputs.map(input => input.value))).toEqual(['Alice','SEA','30','','','']);
});

test('branding, stacked headers and automatic entry preserve focus and CSV', async ({page}) => {
    await authenticated(page);
    await expect(page.locator('header img')).toBeVisible();
    await expect(page.locator('header img')).toHaveJSProperty('complete', true);
    expect(await page.locator('header img').evaluate(img => img.naturalWidth)).toBeGreaterThan(0);
    await expect(page.locator('link[rel="icon"]')).toHaveAttribute('href', '/assets/img/favicon.png');
    await expect(page.locator('#login')).toBeHidden();
    await expect(page.locator('#logout')).toBeVisible();
    await expect(page.locator('#headers')).toBeHidden();
    await expect(page.locator('#picks th').nth(1).locator('span')).toHaveText('NE\nSEA');
    await expect(page.locator('#picks tbody tr')).toHaveCount(1);
    const name = page.getByLabel('Player 1 NAME', {exact:true});
    await name.fill('Alice');
    await expect(name).toBeFocused();
    await expect(page.locator('#picks tbody tr')).toHaveCount(2);
    const request = page.waitForRequest('https://admin.example/**/draft');
    await page.locator('#save').click();
    expect((await request).postDataJSON().csv).toBe('"NAME","NE SEA","TIEBREAKER"\r\n"Alice","",""\r\n');
    await name.fill('');
    await expect(name).toBeFocused();
    await expect(page.locator('#picks tbody tr')).toHaveCount(1);
});
test('session expiry keeps edits and warns before reauthentication or sign-out', async ({page}) => {
    await authenticated(page);
    const name = page.getByLabel('Player 1 NAME', {exact:true});
    await name.fill('Alice');
    page.once('dialog', dialog => dialog.dismiss());
    await page.locator('#logout').click();
    await expect(name).toHaveValue('Alice');
    await page.route('https://admin.example/**/draft', route => route.fulfill({status:401,json:{message:'Unauthorized'}}));
    await page.locator('#save').click();
    await expect(page.locator('#status')).toContainText('Session expired');
    await expect(page.locator('#login')).toBeVisible();
    await expect(name).toHaveValue('Alice');
    expect(await page.evaluate(() => Object.values(localStorage).some(value => value.includes('Alice')))).toBe(true);
});

test('schedule orientation survives reversed headers and aliases; header editor stays in its cell', async ({page}) => {
    await authenticated(page);
    await page.locator('#file').setInputFiles({name:'reverse.csv',mimeType:'text/csv',buffer:Buffer.from('NAME,SEA NE,TIEBREAKER\nAlice,NE,30\n')});
    const header = page.locator('#picks th').nth(1);
    await expect(header.locator('span')).toHaveText('NE\nSEA');
    await expect(page.locator('#headers')).toBeHidden();
    await expect(header.locator('input')).toHaveAttribute('aria-description', /NE away at SEA home/);
    const bounds = await header.evaluate(th => {
        const a = th.getBoundingClientRect(), b = th.querySelector('input').getBoundingClientRect();
        return {left:b.left-a.left, right:a.right-b.right, top:b.top-a.top, bottom:a.bottom-b.bottom};
    });
    for (const distance of Object.values(bounds)) expect(distance).toBeGreaterThanOrEqual(-1);
    const csvRequest = page.waitForRequest('https://admin.example/**/draft');
    await page.locator('#save').click();
    expect((await csvRequest).postDataJSON().csv).toContain('"SEA NE"');
    await expect(page.locator('#status')).toHaveText('Draft saved privately');
    await page.locator('#week').selectOption('1');
    await expect(page.getByLabel('Column 2 header')).toHaveValue('JAX WSH');
    await page.getByLabel('Column 2 header').fill('WAS JAC');
    await expect(header.locator('span')).toHaveText('JAX\nWSH');
    await expect(page.locator('#headers')).toBeHidden();
});

test('debounced partial drafts keep newer edits during an in-flight save and never publish', async ({page}) => {
    await page.clock.install();
    await authenticated(page);
    const writes = [];
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    await page.route('https://admin.example/**/draft', async route => {
        writes.push(route.request().postDataJSON());
        if (writes.length === 1) await gate;
        await route.fulfill({json:{etag:`version${writes.length}`,issues:[]}});
    });
    const published = [];
    page.on('request', request => { if (request.url().endsWith('/submit')) published.push(request.url()); });
    const name = page.getByLabel('Player 1 NAME',{exact:true});
    await name.fill('Alice');
    await page.clock.runFor(3100);
    await expect.poll(() => writes.length).toBe(1);
    await expect(page.locator('#save')).toBeDisabled();
    await name.fill('Alicia');
    await expect(page.locator('#save')).toBeDisabled();
    await expect(name).toBeFocused();
    await page.clock.runFor(4000);
    expect(writes.length).toBe(1);
    release();
    await expect(page.locator('#dirty')).toHaveText('Unsaved changes');
    await expect(page.locator('#save')).toBeEnabled();
    await page.clock.runFor(3100);
    await expect(page.locator('#dirty')).toHaveText('All changes saved');
    expect(writes.length).toBe(2);
    expect(writes[1].etag).toBe('version1');
    expect(writes[1].csv).toBe('"NAME","NE SEA","TIEBREAKER"\r\n"Alicia","",""\r\n');
    expect(published).toEqual([]);
    expect(await page.evaluate(() => Object.values(localStorage).some(value => value.includes('access_token') || value.includes('refresh_token')))).toBe(false);
});

test('offline edits survive reload and reauthentication but restoration never autosaves', {tag:'@smoke'}, async ({page}) => {
    await page.clock.install();
    await authenticated(page);
    let writes = 0;
    await page.route('https://admin.example/**/draft', route => { writes++; return route.abort('internetdisconnected'); });
    await page.getByLabel('Player 1 NAME',{exact:true}).fill('Alice');
    await page.getByLabel('Column 2 header').fill('SEA NE');
    await page.clock.runFor(3100);
    await expect(page.locator('#dirty')).toHaveText('Changes saved on this device; waiting to reconnect');
    await page.goto('/admin/');
    await expect(page.locator('#editor')).toBeHidden();
    await expect(page.locator('body')).not.toContainText('Alice');
    await page.goto('/admin/?code=again&state=state');
    await expect(page.locator('#recovery')).toBeVisible();
    await expect(page.getByLabel('Player 1 NAME',{exact:true})).toHaveValue('');
    await page.locator('#restore-device').click();
    await expect(page.getByLabel('Player 1 NAME',{exact:true})).toHaveValue('Alice');
    await expect(page.getByLabel('Column 2 header')).toHaveValue('SEA NE');
    const previous = writes;
    await page.getByLabel('Player 1 TIEBREAKER',{exact:true}).fill('42');
    await page.clock.runFor(6000); expect(writes).toBe(previous);
    await page.route('https://admin.example/**/draft', route => route.fulfill({json:{etag:'recovered',issues:[]}}));
    page.once('dialog', dialog => dialog.accept());
    await page.locator('#save').click();
    await expect(page.locator('#dirty')).toHaveText('All changes saved');
    expect(await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('pbj.draft.') && !key.endsWith('.selection')))).toEqual([]);
});

test('a newer shared draft requires explicit recovery review and cannot be overwritten by autosave', async ({page}) => {
    await page.clock.install();
    await authenticated(page);
    await page.getByLabel('Player 1 NAME',{exact:true}).fill('Alice');
    await authenticated(page, {etag:'newer',rows:[['Bob','SEA','30']]});
    await expect(page.locator('#recovery-message')).toContainText('A newer draft exists');
    await expect(page.getByLabel('Player 1 NAME',{exact:true})).toHaveValue('Bob');
    await expect(page.getByLabel('Player 1 NAME',{exact:true})).toBeDisabled();
    let writes = 0;
    await page.route('https://admin.example/**/draft', route => { writes++; return route.fulfill({status:409,json:{message:'Draft changed in another session. Reopen before saving.'}}); });
    await page.clock.runFor(6000); expect(writes).toBe(0);
    await page.evaluate(() => {
        const dataTransfer = new DataTransfer();
        dataTransfer.items.add(new File(['NAME,NE SEA,TIEBREAKER\nIntruder,NE,1'], 'replacement.csv', {type:'text/csv'}));
        document.getElementById('drop').dispatchEvent(new DragEvent('drop', {dataTransfer,bubbles:true}));
    });
    await expect(page.locator('#status')).toContainText('Restore or discard');
    await page.locator('#restore-device').click();
    await expect(page.getByLabel('Player 1 NAME',{exact:true})).toHaveValue('Alice');
    await page.clock.runFor(6000); expect(writes).toBe(0);
    page.once('dialog', dialog => dialog.accept());
    await page.locator('#save').click();
    await expect(page.locator('#dirty')).toContainText('A newer draft exists');
    await page.getByLabel('Player 1 NAME',{exact:true}).fill('Alicia');
    await page.clock.runFor(6000); expect(writes).toBe(1);
    expect(await page.evaluate(() => Object.values(localStorage).some(value => value.includes('Alicia')))).toBe(true);
});

test('account isolation, rejected identity, and deliberate device-copy discard', async ({page}) => {
    await page.clock.install();
    await authenticated(page);
    await page.getByLabel('Player 1 NAME',{exact:true}).fill('Alice');
    await authenticated(page, {user:'other-commissioner'});
    await expect(page.locator('#recovery')).toBeHidden();
    await expect(page.getByLabel('Player 1 NAME',{exact:true})).toHaveValue('');
    await expect(page.locator('body')).not.toContainText('Alice');
    await authenticated(page);
    await expect(page.locator('#recovery')).toBeVisible();
    await page.locator('#discard-device').click();
    await expect(page.locator('#recovery')).toBeHidden();
    await expect(page.getByLabel('Player 1 NAME',{exact:true})).toBeEnabled();
    await page.getByLabel('Player 1 NAME',{exact:true}).fill('Private');
    await page.route('https://admin.example/schedules', route => route.fulfill({status:403,json:{message:'Forbidden'}}));
    await page.goto('/admin/?code=revoked&state=state');
    await expect(page.locator('#editor')).toBeHidden();
    await expect(page.locator('#recovery')).toBeHidden();
    await expect(page.locator('body')).not.toContainText('Private');
});

test('disabled storage reports reduced recovery while still allowing server saving', async ({page}) => {
    await page.addInitScript(() => {
        const original = Storage.prototype.setItem;
        Storage.prototype.setItem = function(key, value) {
            if (this === localStorage) throw new DOMException('Full', 'QuotaExceededError');
            return original.call(this, key, value);
        };
    });
    await authenticated(page);
    await page.getByLabel('Player 1 NAME',{exact:true}).fill('Alice');
    await expect(page.locator('#recovery-status')).toContainText('recovery is unavailable');
    await page.locator('#save').click();
    await expect(page.locator('#dirty')).toHaveText('All changes saved');
});

test('expired access is renewed before autosaving without interrupting entry', async ({page}) => {
    await page.clock.install();
    await authenticated(page);
    let refreshes = 0;
    await page.route('https://login.example/oauth2/token', route => {
        const body = new URLSearchParams(route.request().postData());
        expect(body.get('grant_type')).toBe('refresh_token');
        expect(body.get('refresh_token')).toBe('test-refresh');
        refreshes++;
        return route.fulfill({json:{access_token:'renewed',expires_in:1800}});
    });
    await page.route('https://admin.example/**/draft', route => {
        expect(route.request().headers().authorization).toBe('Bearer renewed');
        return route.fulfill({json:{etag:'renewed-save',issues:[]}});
    });
    await page.clock.fastForward(31 * 60000);
    const name = page.getByLabel('Player 1 NAME',{exact:true});
    await name.fill('Alice');
    await page.clock.runFor(3100);
    await expect(page.locator('#dirty')).toHaveText('All changes saved');
    await expect(name).toBeFocused();
    await expect(page.locator('#login')).toBeHidden();
    expect(refreshes).toBe(1);
    expect(await page.evaluate(() => JSON.stringify(localStorage).includes('test-refresh') || JSON.stringify(localStorage).includes('renewed'))).toBe(false);
});

test('revoked refresh preserves local work before deliberate sign-in and Cognito logout', async ({page}) => {
    await page.clock.install();
    await authenticated(page);
    await page.route('https://login.example/oauth2/token', route => route.fulfill({status:400,json:{error:'invalid_grant'}}));
    await page.clock.fastForward(31 * 60000);
    await page.getByLabel('Player 1 NAME',{exact:true}).fill('Alice');
    await page.clock.runFor(3100);
    await expect(page.locator('#login')).toHaveText('Sign in to continue');
    await expect(page.locator('#status')).toContainText('Session expired');
    await expect(page.getByLabel('Player 1 NAME',{exact:true})).toHaveValue('Alice');
    await page.route('https://login.example/oauth2/authorize?**', route => route.fulfill({body:'Managed login'}));
    await page.locator('#login').click();
    await page.waitForURL('https://login.example/oauth2/authorize?**');
    // The retained picks are not displayed before another verified sign-in.
    await expect(page.locator('body')).not.toContainText('Alice');
    await authenticated(page);
    await expect(page.locator('#recovery')).toBeVisible();
    await page.locator('#restore-device').click();
    await page.route('https://login.example/logout?**', route => route.fulfill({body:'Signed out'}));
    page.once('dialog', dialog => dialog.accept());
    await page.locator('#logout').click();
    await page.waitForURL('https://login.example/logout?**');
    const url = new URL(page.url());
    expect(url.searchParams.get('client_id')).toBe('spa');
    expect(url.searchParams.has('access_token')).toBe(false);
    expect(url.searchParams.has('refresh_token')).toBe(false);
});

test('browser storage recovery survives a new context without carrying authentication', async ({page, browser}) => {
    await page.clock.install();
    await authenticated(page);
    await page.getByLabel('Player 1 NAME',{exact:true}).fill('Restart');
    const state = await page.context().storageState();
    const restarted = await browser.newContext({storageState:state,baseURL:'http://127.0.0.1:8000'});
    try {
        const restoredPage = await restarted.newPage();
        await restoredPage.goto('http://127.0.0.1:8000/admin/');
        await expect(restoredPage.locator('#editor')).toBeHidden();
        await expect(restoredPage.locator('body')).not.toContainText('Restart');
        await authenticated(restoredPage);
        await restoredPage.locator('#restore-device').click();
        await expect(restoredPage.getByLabel('Player 1 NAME',{exact:true})).toHaveValue('Restart');
    } finally { await restarted.close(); }
});


test('unresolved CSV interpretation is retained locally without background server writes', async ({page}) => {
    await page.clock.install();
    await authenticated(page);
    let writes = 0;
    page.on('request', request => { if (request.url().endsWith('/draft')) writes++; });
    await page.locator('#file').setInputFiles({name:'headerless.csv',mimeType:'text/csv',buffer:Buffer.from('Alice,SEA,30\n')});
    await expect(page.locator('#header-choice')).toBeVisible();
    await page.clock.runFor(6000); expect(writes).toBe(0);
    await page.goto('/admin/?code=again&state=state');
    await page.locator('#restore-device').click();
    await expect(page.locator('#header-choice')).toBeVisible();
    await expect(page.locator('[data-row="0"][data-column="0"]')).toHaveValue('Alice');
    await page.clock.runFor(6000); expect(writes).toBe(0);
});


test('full browser storage still allows an existing recovery copy to be read', async ({page}) => {
    await page.clock.install();
    await authenticated(page);
    await page.getByLabel('Player 1 NAME',{exact:true}).fill('Recover despite quota');
    await page.addInitScript(() => {
        const original = Storage.prototype.setItem;
        Storage.prototype.setItem = function(key, value) {
            if (this === localStorage) throw new DOMException('Full', 'QuotaExceededError');
            return original.call(this, key, value);
        };
    });
    await page.goto('/admin/?code=again&state=state');
    await expect(page.locator('#recovery')).toBeVisible();
    await page.locator('#restore-device').click();
    await expect(page.getByLabel('Player 1 NAME',{exact:true})).toHaveValue('Recover despite quota');
    await expect(page.locator('#recovery-status')).toContainText('recovery is unavailable');
});


test('recovery provenance survives repeated reloads, failures and concurrent server changes', async ({page}) => {
    await page.clock.install();
    await authenticated(page, {etag:'old'});
    await page.getByLabel('Player 1 NAME',{exact:true}).fill('Alice');
    await authenticated(page, {etag:'new',rows:[['Bob','SEA','30']]});
    const base = () => page.evaluate(() => JSON.parse(Object.entries(localStorage).find(([key]) => key.startsWith('pbj.draft.') && !key.endsWith('.selection'))[1]).etag);
    await expect(page.locator('#recovery-message')).toContainText('A newer draft exists');
    await page.locator('#restore-device').click();
    await expect(page.locator('#save')).toBeEnabled();
    await expect(page.locator('#status')).toContainText('newer server draft');
    await page.getByLabel('Player 1 TIEBREAKER',{exact:true}).fill('42');
    expect(await base()).toBe('old');
    await page.locator('#validate').click();
    await expect(page.locator('#dirty')).toContainText('newer server draft');
    await page.goto('/admin/?code=reload&state=state');
    await expect(page.locator('#recovery-message')).toContainText('A newer draft exists');
    await page.locator('#restore-device').click();
    expect(await base()).toBe('old');
    const writes = [];
    await page.route('https://admin.example/**/draft', route => {
        writes.push(route.request().postDataJSON());
        return route.fulfill({status:502,json:{message:'Save failed'}});
    });
    page.once('dialog', dialog => dialog.dismiss());
    await page.locator('#save').click();
    expect(writes).toEqual([]);
    page.once('dialog', dialog => dialog.accept());
    await page.locator('#save').click();
    await expect(page.locator('#status')).toContainText('Save failed');
    await expect(page.locator('#save')).toBeEnabled();
    expect(writes[0].etag).toBe('new');
    expect(await base()).toBe('old');
    await page.route('https://admin.example/**/draft', route => {
        writes.push(route.request().postDataJSON());
        return route.fulfill({status:409,json:{message:'Draft changed in another session. Reopen before saving.'}});
    });
    page.once('dialog', dialog => dialog.accept());
    await page.locator('#save').click();
    await expect(page.locator('#status')).toContainText('Draft changed');
    await expect(page.locator('#save')).toBeDisabled();
    expect(writes[1].etag).toBe('new'); expect(await base()).toBe('old');
    await authenticated(page, {etag:'newest',rows:[['Carol','NE','35']]});
    await expect(page.locator('#recovery-message')).toContainText('A newer draft exists');
    await page.locator('#restore-device').click();
    await page.route('https://admin.example/**/draft', route => {
        writes.push(route.request().postDataJSON());
        return route.fulfill({json:{etag:'resolved',issues:[]}});
    });
    page.once('dialog', dialog => dialog.accept());
    await page.locator('#save').click();
    await expect(page.locator('#dirty')).toHaveText('All changes saved');
    await expect(page.locator('#save')).toBeDisabled();
    expect(writes[2].etag).toBe('newest');
    expect(writes[2].csv).toContain('"Alice","","42"');
    expect(await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('pbj.draft.') && !key.endsWith('.selection')))).toEqual([]);
});

test('native save availability follows edits, autosave, uploads, interpretation and week changes', async ({page}) => {
    await page.clock.install();
    await authenticated(page);
    const save = page.locator('#save');
    await expect(save).toBeDisabled();
    const writes = [];
    page.on('request', request => { if (request.url().endsWith('/draft')) writes.push(request.url()); });
    await save.evaluate(button => button.onclick());
    await expect(page.locator('#status')).not.toHaveText('Draft saved privately');
    expect(writes).toEqual([]);
    await page.getByLabel('Player 1 NAME',{exact:true}).fill('Alice');
    await expect(save).toBeEnabled();
    await page.clock.runFor(3100);
    await expect(page.locator('#dirty')).toHaveText('All changes saved');
    await expect(save).toBeDisabled();
    await expect(page.locator('#submit')).toBeEnabled();
    await page.locator('#week').selectOption('1');
    await expect(page.locator('#status')).toHaveText('Season 2026 · Week 1');
    await expect(save).toBeDisabled();
    await page.getByLabel('Column 2 header').fill('WAS JAC');
    await expect(save).toBeEnabled();
    await save.click();
    await expect(save).toBeDisabled();
    await page.locator('#file').setInputFiles({name:'partial.csv',mimeType:'text/csv',buffer:Buffer.from('Alice,JAX,\n')});
    await expect(page.locator('#header-choice')).toBeVisible();
    await expect(save).toBeDisabled();
    await page.locator('#first-players').click();
    await expect(save).toBeEnabled();
    await page.route('https://admin.example/**/draft', route => route.abort('internetdisconnected'));
    await page.clock.runFor(3100);
    await expect(page.locator('#dirty')).toContainText('waiting to reconnect');
    await expect(save).toBeEnabled();
});


test('matching content does not erase unresolved older recovery provenance', async ({page}) => {
    await page.clock.install();
    await authenticated(page, {etag:'old',rows:[['Original','SEA','30']]});
    const name = page.getByLabel('Player 1 NAME',{exact:true});
    await name.fill('Alice');
    await authenticated(page, {etag:'new',rows:[['Alice','SEA','30']]});
    await expect(page.locator('#recovery')).toBeVisible();
    await expect(page.locator('#recovery-message')).toContainText('A newer draft exists');
    await page.locator('#restore-device').click();
    await expect(page.locator('#save')).toBeEnabled();
    expect(await page.evaluate(() => JSON.parse(Object.entries(localStorage).find(([key]) => key.startsWith('pbj.draft.') && !key.endsWith('.selection'))[1]).etag)).toBe('old');
});

test('published picks open clean, autosave only after editing, and retain device recovery', async ({page}) => {
    await page.clock.install();
    const writes = [];
    page.on('request', request => {
        if (request.url().endsWith('/draft')) writes.push(request.postDataJSON());
    });
    await authenticated(page, {published:true,rows:[['Alice','SEA','42.5'],['Bob','N/P','0']]});
    page.once('dialog',d => d.accept()); await page.locator('#edit-published').click();
    await expect(page.getByLabel('Player 1 NAME',{exact:true})).toHaveValue('Alice');
    await expect(page.getByLabel('Player 1 TIEBREAKER',{exact:true})).toHaveValue('42.5');
    await expect(page.locator('#picks tbody tr')).toHaveCount(3);
    await expect(page.locator('#save')).toBeDisabled();
    await page.clock.runFor(6000);
    expect(writes).toEqual([]);
    await page.locator('[data-row="0"][data-column="1"]').fill('NE');
    await expect(page.locator('#save')).toBeEnabled();
    await page.clock.runFor(3100);
    await expect(page.locator('#save')).toBeDisabled();
    expect(writes).toHaveLength(1);
    expect(writes[0].etag).toBeNull();
    expect(writes[0].csv).toContain('"Alice","NE","42.5"');
    await page.getByLabel('Player 1 TIEBREAKER',{exact:true}).fill('50');
    await authenticated(page, {published:true,rows:[['Alice','SEA','42.5'],['Bob','N/P','0']]});
    page.once('dialog',d => d.accept()); await page.locator('#edit-published').click();
    await expect(page.locator('#recovery')).toBeVisible();
    await expect(page.getByLabel('Player 1 TIEBREAKER',{exact:true})).toHaveValue('42.5');
    await page.locator('#restore-device').click();
    await expect(page.getByLabel('Player 1 TIEBREAKER',{exact:true})).toHaveValue('50');
});

for (const etag of [null, 'draft']) {
    test(`published protection with draft ${etag} covers mutation paths and separate submission`, async ({page}) => {
        await authenticated(page, {etag,published:true,rows:[['Alice','SEA','30']]});
        await expect(page.locator('#published-warning')).toBeVisible();
        for (const selector of ['#file','#empty','#restore-device','#submit','[data-row="0"][data-column="0"]','[data-row="-1"][data-column="0"]']) {
            await expect(page.locator(selector)).toBeDisabled();
        }
        await page.evaluate(() => {
            const transfer = new DataTransfer();
            transfer.items.add(new File(['NAME,NE SEA,TIEBREAKER\nDropped,NE,50'], 'picks.csv', {type:'text/csv'}));
            document.getElementById('drop').dispatchEvent(new DragEvent('drop', {dataTransfer:transfer,bubbles:true,cancelable:true}));
        });
        await expect(page.getByLabel('Player 1 NAME',{exact:true})).toHaveValue('Alice');
        page.once('dialog', d => d.dismiss()); await page.locator('#edit-published').click();
        await expect(page.locator('#empty')).toBeDisabled();
        page.once('dialog', d => d.accept()); await page.locator('#edit-published').click();
        await expect(page.locator('#published-warning')).toBeVisible();
        await page.getByLabel('Player 1 NAME',{exact:true}).fill('Bob');
        const submissions = [];
        page.on('request', r => { if (r.url().endsWith('/submit')) submissions.push(r.postDataJSON()); });
        page.once('dialog', d => d.dismiss()); await page.locator('#submit').click();
        expect(submissions).toEqual([]);
        page.once('dialog', d => d.accept()); await page.locator('#submit').click();
        await expect(page.locator('#status')).toContainText('submitted');
        expect(submissions[0].acknowledge_published).toBe(true);
    });
}
for (const source of ['empty','published','draft']) {
    test(`revert from ${source} before and after autosave`, async ({page}) => {
        await page.clock.install();
        const rows = source === 'empty' ? [] : [['Alice','SEA','30']];
        await authenticated(page,{rows,etag:source === 'draft' ? 'original' : null,published:source === 'published'});
        if (source === 'published') { page.once('dialog', d => d.accept()); await page.locator('#edit-published').click(); }
        await expect(page.locator('#revert')).toBeHidden();
        const requests = [];
        page.on('request', r => { if (r.url().endsWith('/draft')) requests.push({method:r.method(),body:r.postDataJSON()}); });
        for (const autosave of [false,true]) {
            await page.getByLabel('Player 1 NAME',{exact:true}).fill('Changed');
            await expect(page.locator('#revert')).toBeVisible();
            if (autosave) { await page.clock.runFor(3100); await expect(page.locator('#save')).toBeDisabled(); }
            page.once('dialog', d => d.accept()); await page.locator('#revert').click();
            await expect(page.getByLabel('Player 1 NAME',{exact:true})).toHaveValue(rows[0]?.[0] || '');
            await expect(page.locator('#revert')).toBeHidden();
            const count = requests.length; await page.clock.runFor(6000); expect(requests).toHaveLength(count);
            if (!autosave) expect(requests).toEqual([]);
        }
        expect(requests.map(r => r.method)).toEqual(source === 'draft' ? ['PUT','PUT'] : ['PUT','DELETE']);
    });
}
test('draft deletion is contextual, confirmed, conditional and preserves work on failure', async ({page}) => {
    await authenticated(page);
    await expect(page.locator('#delete-draft')).toBeHidden(); await expect(page.locator('#reopen')).toBeHidden();
    await authenticated(page,{etag:'original',rows:[['Alice','SEA','30']]});
    await expect(page.locator('#delete-draft')).toBeVisible(); await expect(page.locator('#reopen')).toBeHidden();
    await page.getByLabel('Player 1 NAME',{exact:true}).fill('Bob');
    await expect(page.locator('#reopen')).toBeVisible();
    const requests = [];
    await page.route('https://admin.example/**/draft', route => {
        requests.push(route.request().postDataJSON()); return route.fulfill({status:409,json:{message:'Draft changed'}});
    });
    page.once('dialog', d => d.dismiss()); await page.locator('#delete-draft').click(); expect(requests).toEqual([]);
    page.once('dialog', d => { expect(d.message()).toContain('2026'); expect(d.message()).toContain('2'); return d.accept(); });
    await page.locator('#delete-draft').click(); await expect(page.locator('#status')).toContainText('Draft changed');
    expect(requests[0].etag).toBe('original');
    await expect(page.getByLabel('Player 1 NAME',{exact:true})).toHaveValue('Bob');
    expect(await page.evaluate(() => Object.keys(localStorage).some(k => k.startsWith('pbj.draft.') && !k.endsWith('.selection')))).toBe(true);
});

for (const published of [false,true]) {
    test(`successful deletion reloads ${published ? 'published picks' : 'empty schedule'} and clears recovery`, async ({page}) => {
        await page.clock.install();
        await authenticated(page,{etag:'original',published,rows:[['Private','SEA','30']]});
        if (published) { page.once('dialog',d => d.accept()); await page.locator('#edit-published').click(); }
        await page.getByLabel('Player 1 NAME',{exact:true}).fill('Unsaved');
        await page.route('https://admin.example/weeks/2026/2', route => route.fulfill({json:{
            headers:['NAME','NE SEA','TIEBREAKER'],games:[{id:'game',away:'NE',home:'SEA'}],
            rows:published ? [['Public','SEA','42']] : [],etag:null,source:published ? 'published' : 'empty',published,issues:[],
        }}));
        const deletes = [];
        await page.route('https://admin.example/**/draft', route => {
            expect(route.request().method()).toBe('DELETE'); deletes.push(route.request().postDataJSON());
            return route.fulfill({json:{message:'Private draft deleted'}});
        });
        page.once('dialog',d => d.accept()); await page.locator('#delete-draft').click();
        await expect(page.getByLabel('Player 1 NAME',{exact:true})).toHaveValue(published ? 'Public' : '');
        await expect(page.locator('#delete-draft')).toBeHidden(); await expect(page.locator('#revert')).toBeHidden();
        await expect(page.locator('#published-warning'))[published ? 'toBeVisible' : 'toBeHidden']();
        await page.clock.runFor(6000); expect(deletes).toEqual([{etag:'original'}]);
        expect(await page.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith('pbj.draft.') && !k.endsWith('.selection')))).toEqual([]);
    });
}
test('reopen uses the saved draft and preserves work when that draft disappears', {tag:'@smoke'}, async ({page}) => {
    await page.clock.install();
    await authenticated(page,{etag:'original',rows:[['Original','SEA','30']]});
    await page.getByLabel('Player 1 NAME',{exact:true}).fill('Local');
    page.once('dialog',d => d.dismiss()); await page.locator('#reopen').click();
    await expect(page.getByLabel('Player 1 NAME',{exact:true})).toHaveValue('Local');
    const recoveryBefore = await page.evaluate(() => Object.entries(localStorage).find(([k]) => k.startsWith('pbj.draft.') && !k.endsWith('.selection'))[1]);
    await page.route('https://admin.example/weeks/2026/2', route => route.fulfill({status:502,json:{message:'Fetch failed'}}));
    page.once('dialog',d => d.accept()); await page.locator('#reopen').click();
    await expect(page.locator('#status')).toContainText('Fetch failed');
    expect(await page.evaluate(() => Object.entries(localStorage).find(([k]) => k.startsWith('pbj.draft.') && !k.endsWith('.selection'))[1])).toBe(recoveryBefore);
    await page.route('https://admin.example/weeks/2026/2', route => route.fulfill({json:{
        source:'published',published:true,etag:null,rows:[['Public','SEA','42']],
    }}));
    page.once('dialog',d => d.accept()); await page.locator('#reopen').click();
    await expect(page.locator('#status')).toContainText('saved draft no longer exists');
    await expect(page.getByLabel('Player 1 NAME',{exact:true})).toHaveValue('Local');
    await page.route('https://admin.example/weeks/2026/2', route => route.fulfill({json:{
        source:'draft',published:false,etag:'latest',rows:[['Shared','NE','35']],
        headers:['NAME','NE SEA','TIEBREAKER'],games:[{id:'game',away:'NE',home:'SEA'}],issues:[],
    }}));
    page.once('dialog',d => d.accept()); await page.locator('#reopen').click();
    await expect(page.getByLabel('Player 1 NAME',{exact:true})).toHaveValue('Shared');
    await expect(page.locator('#revert')).toBeHidden();
    await expect(page.locator('#recovery')).toBeHidden();
    expect(await page.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith('pbj.draft.') && !k.endsWith('.selection')))).toEqual([]);
});
for (const failure of [409,502]) {
    test(`revert persistence failure ${failure} retains table and device recovery`, async ({page}) => {
        await page.clock.install();
        await authenticated(page,{etag:'original',rows:[['Original','SEA','30']]});
        await page.getByLabel('Player 1 NAME',{exact:true}).fill('Saved edit');
        await page.clock.runFor(3100); await expect(page.locator('#save')).toBeDisabled();
        await page.route('https://admin.example/**/draft', route => route.fulfill({status:failure,json:{message:'Reconciliation failed'}}));
        page.once('dialog',d => d.accept()); await page.locator('#revert').click();
        await expect(page.locator('#status')).toContainText('Reconciliation failed');
        await expect(page.getByLabel('Player 1 NAME',{exact:true})).toHaveValue('Saved edit');
        await expect(page.locator('#revert')).toBeVisible(); await expect(page.locator('#save')).toBeDisabled();
        expect(await page.evaluate(() => JSON.parse(Object.entries(localStorage).find(([k]) => k.startsWith('pbj.draft.') && !k.endsWith('.selection'))[1]).table.rows[0][0])).toBe('Saved edit');
    });
}
test('revert suspends autosave while a pending write settles', async ({page}) => {
    await page.clock.install(); await authenticated(page);
    let finish; const gate = new Promise(resolve => { finish = resolve; }); const methods = [];
    await page.route('https://admin.example/**/draft', async route => {
        methods.push(route.request().method());
        if (route.request().method() === 'PUT') await gate;
        return route.fulfill({json:{etag:'saved',issues:[]}});
    });
    await page.getByLabel('Player 1 NAME',{exact:true}).fill('Pending');
    await page.clock.runFor(3100); await expect.poll(() => methods.length).toBe(1);
    const reverting = page.locator('#revert').click();
    await expect(page.locator('#file')).toBeDisabled();
    page.once('dialog',d => d.accept()); finish(); await reverting;
    await expect(page.getByLabel('Player 1 NAME',{exact:true})).toHaveValue('');
    await expect(page.locator('#revert')).toBeHidden(); await page.clock.runFor(6000);
    expect(methods).toEqual(['PUT','DELETE']);
});

test('successful deletion followed by reload failure hides the stale editor and directs a refresh', async ({page}) => {
    await page.clock.install(); await authenticated(page,{etag:'original'});
    await page.getByLabel('Player 1 NAME',{exact:true}).fill('Local');
    await page.route('https://admin.example/weeks/2026/2', route => route.fulfill({status:502,json:{message:'Reload unavailable'}}));
    const methods = [];
    await page.route('https://admin.example/**/draft', route => {
        methods.push(route.request().method()); return route.fulfill({json:{message:'Deleted'}});
    });
    page.once('dialog',d => d.accept()); await page.locator('#delete-draft').click();
    await expect(page.locator('#status')).toHaveText('Draft deleted, but the week could not be reloaded. Refresh the portal to continue.');
    await expect(page.locator('#editor')).toBeHidden();
    for (const selector of ['#picks input','#empty','#headers','#file','#validate','#save','#submit','#revert','#delete-draft','#reopen','#season','#week']) {
        for (const control of await page.locator(selector).all()) await expect(control).toBeHidden();
    }
    await page.clock.runFor(6000); expect(methods).toEqual(['DELETE']);
});

for (const etag of [null,'original']) {
    test(`manual return to original values still offers persisted revert (${etag})`, async ({page}) => {
        await page.clock.install();
        await authenticated(page,{etag,rows:[['Original','SEA','30']]});
        const name = page.getByLabel('Player 1 NAME',{exact:true});
        await name.fill('Saved edit'); await page.clock.runFor(3100);
        await expect(page.locator('#save')).toBeDisabled();
        await name.fill('Original'); await expect(page.locator('#revert')).toBeVisible();
        const writes = [];
        await page.route('https://admin.example/**/draft', route => {
            writes.push({method:route.request().method(),body:route.request().postDataJSON()});
            return route.fulfill({json:{etag:'restored',issues:[]}});
        });
        page.once('dialog',d => d.accept()); await page.locator('#revert').click();
        await expect(page.locator('#revert')).toBeHidden();
        expect(writes[0].method).toBe(etag ? 'PUT' : 'DELETE'); expect(writes[0].body.etag).toBe('saved');
        await page.clock.runFor(6000); expect(writes).toHaveLength(1);
    });
}
for (const serverEtag of [null,'unconfirmed']) {
    test(`uncertain initial save can recover with server draft ${serverEtag}`, async ({page}) => {
        await page.clock.install(); await authenticated(page);
        await page.getByLabel('Player 1 NAME',{exact:true}).fill('Recover me');
        await page.route('https://admin.example/**/draft', route => {
            expect(route.request().method()).toBe('PUT'); return route.fulfill({status:502,json:{message:'Save outcome unknown'}});
        });
        await page.locator('#save').click(); await expect(page.locator('#status')).toContainText('Save outcome unknown');
        await page.route('https://admin.example/weeks/2026/2', route => route.fulfill({json:{
            etag:serverEtag,source:serverEtag ? 'draft' : 'empty',published:false,
            headers:['NAME','NE SEA','TIEBREAKER'],rows:serverEtag ? [['Shared','SEA','35']] : [],
            games:[{id:'game',away:'NE',home:'SEA'}],issues:[],
        }}));
        page.once('dialog',d => d.accept()); await page.locator('#revert').click();
        if (serverEtag) {
            await expect(page.locator('#status')).toContainText('Reopen Saved Draft');
            await expect(page.getByLabel('Player 1 NAME',{exact:true})).toHaveValue('Recover me');
            await expect(page.locator('#reopen')).toBeVisible();
            expect(await page.evaluate(() => Object.keys(localStorage).some(k => k.startsWith('pbj.draft.') && !k.endsWith('.selection')))).toBe(true);
            page.once('dialog',d => d.dismiss()); await page.locator('#reopen').click();
            await expect(page.getByLabel('Player 1 NAME',{exact:true})).toHaveValue('Recover me');
            page.once('dialog',d => d.accept()); await page.locator('#reopen').click();
            await expect(page.getByLabel('Player 1 NAME',{exact:true})).toHaveValue('Shared');
        } else {
            await expect(page.getByLabel('Player 1 NAME',{exact:true})).toHaveValue('');
            await expect(page.locator('#revert')).toBeHidden();
            await page.getByLabel('Player 1 NAME',{exact:true}).fill('Retry'); await expect(page.locator('#save')).toBeEnabled();
        }
        await expect(page.locator('#recovery')).toBeHidden();
    });
}

for (const etag of [null,'original']) {
    test(`return to baseline before autosave leaves the server draft untouched (${etag})`, async ({page}) => {
        await page.clock.install();
        await authenticated(page,{etag,published:true,rows:[['Original','SEA','30']]});
        page.once('dialog',d => d.accept()); await page.locator('#edit-published').click();
        const writes = [];
        page.on('request',r => { if (r.url().endsWith('/draft')) writes.push(r.method()); });
        const name = page.getByLabel('Player 1 NAME',{exact:true});
        await name.fill('Temporary'); await expect(page.locator('#save')).toBeEnabled();
        await name.fill('Original'); await expect(page.locator('#save')).toBeDisabled();
        await expect(page.locator('#revert')).toBeHidden();
        await page.clock.runFor(6000); expect(writes).toEqual([]);
        await expect(page.locator('#delete-draft'))[etag ? 'toBeVisible' : 'toBeHidden']();
        expect(await page.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith('pbj.draft.') && !k.endsWith('.selection')))).toEqual([]);
    });
}
for (const status of [409,502]) {
    test(`failed draft deletion ${status} never resumes automatic persistence`, async ({page}) => {
        await page.clock.install();
        await authenticated(page,{etag:'original',rows:[['Original','SEA','30']]});
        const name = page.getByLabel('Player 1 NAME',{exact:true}); await name.fill('Keep me');
        const methods = [];
        await page.route('https://admin.example/**/draft', route => {
            methods.push(route.request().method());
            return route.fulfill({status,json:{message:'Deletion failed'}});
        });
        page.once('dialog',d => d.accept()); await page.locator('#delete-draft').click();
        await expect(page.locator('#status')).toContainText('Deletion failed');
        await page.clock.runFor(6000); expect(methods).toEqual(['DELETE']);
        await expect(name).toHaveValue('Keep me'); await expect(page.locator('#save')).toBeDisabled();
        await expect(page.locator('#reopen')).toBeVisible();
        expect(await page.evaluate(() => JSON.parse(Object.entries(localStorage).find(([k]) => k.startsWith('pbj.draft.') && !k.endsWith('.selection'))[1]).table.rows[0][0])).toBe('Keep me');
        await name.fill('Still recoverable'); await page.clock.runFor(6000); expect(methods).toEqual(['DELETE']);
    });
}

test('create next week confirms, blocks duplicates, refreshes and opens its schedule', async ({page}) => {
    await authenticated(page, {published:true});
    let created = false, requests = 0, release;
    await page.route('https://admin.example/schedules', route => route.fulfill({json:{
        seasons:{2026:created ? [1,2,3] : [1,2]}, season:2026, week:2, user_id:'commissioner',
        next_creation:created ? null : {season:2026,week:3,token:'catalog-version'},
    }}));
    await page.route('https://admin.example/schedules/next', async route => {
        requests++;
        expect(route.request().postDataJSON()).toEqual({token:'catalog-version',confirm:true});
        await new Promise(resolve => { release = resolve; });
        created = true;
        await route.fulfill({json:{season:2026,week:3,message:'Schedule ready'}});
    });
    await page.route('https://admin.example/weeks/2026/3', route => route.fulfill({json:{
        headers:['NAME','BUF NYJ','TIEBREAKER'], games:[{id:'new',away:'BUF',home:'NYJ'}],
        rows:[], etag:null, published:false, issues:[],
    }}));
    await page.goto('/admin/?code=code&state=state');
    const create = page.getByRole('button', {name:'Create Week 3',exact:true});
    await expect(create).toBeEnabled();
    page.once('dialog', dialog => dialog.dismiss());
    await create.click();
    expect(requests).toBe(0);
    page.once('dialog', dialog => {
        expect(dialog.message()).toContain('Tuesday at 8:00 AM Eastern');
        return dialog.accept();
    });
    await create.click();
    await expect(create).toBeDisabled();
    await expect.poll(() => requests).toBe(1);
    release();
    await expect(page.locator('#week')).toHaveValue('3');
    await expect(page.getByLabel('Column 2 header')).toHaveValue('BUF NYJ');
    await expect(page.locator('#picks thead')).toContainText('BUF\nNYJ');
    await expect(create).toBeHidden();
    await page.getByLabel('Player 1 NAME',{exact:true}).fill('Alice');
    await expect(page.locator('#save')).toBeEnabled();
    await page.locator('#save').click();
    await expect(page.locator('#status')).toHaveText('Draft saved privately');
});


for (const selected of [undefined, {season:2026,week:1}, {season:2026,week:3}, {season:2026,week:18}]) {
    test(`lazy catalog opens only the public default or valid remembered week (${selected?.week ?? 'default'})`, {tag:selected === undefined ? '@smoke' : []}, async ({page}) => {
        const requests = [];
        page.on('request', request => {
            if (request.url().startsWith('https://admin.example/')) requests.push(new URL(request.url()).pathname);
        });
        await authenticated(page, {selected,unpublished:true});
        const expected = selected?.week === 1 || selected?.week === 3 ? selected.week : 2;
        await expect(page.locator('#week')).toHaveValue(String(expected));
        await expect(page.locator('#week option[value="3"]')).toHaveCount(1);
        expect(requests).toEqual(['/schedules', `/weeks/2026/${expected}`]);
        const next = expected === 1 ? 2 : 1;
        await page.locator('#week').selectOption(String(next));
        await expect(page.locator('#status')).toHaveText(`Season 2026 · Week ${next}`);
        expect(requests).toEqual(['/schedules', `/weeks/2026/${expected}`, `/weeks/2026/${next}`]);
    });
}

test('uncertain creation refreshes metadata and preserves the selected editor without retrying', async ({page}) => {
    await authenticated(page);
    let failed = false, creations = 0;
    await page.route('https://admin.example/schedules', route => route.fulfill({json:{
        seasons:{2026:failed ? [1,2,3] : [1,2]},season:2026,week:2,user_id:'commissioner',
        next_creation:failed ? null : {season:2026,week:3,token:'version'},
    }}));
    await page.route('https://admin.example/schedules/next', route => {
        creations++; failed = true;
        return route.fulfill({status:409,json:{message:'Schedule now exists; refresh to open it.'}});
    });
    await page.route('https://admin.example/weeks/2026/3', route => route.fulfill({json:{
        headers:['NAME','BUF NYJ','TIEBREAKER'], games:[{id:'new',away:'BUF',home:'NYJ'}],
        rows:[], etag:null, published:false, issues:[],
    }}));
    await page.goto('/admin/?code=code&state=state');
    await page.clock.install();
    await page.getByLabel('Player 1 NAME',{exact:true}).fill('Preserve my edits');
    const recovery = () => page.evaluate(() => Object.entries(localStorage).filter(([key]) => key.startsWith('pbj.draft.') && !key.endsWith('.selection')));
    const retained = await recovery();
    expect(retained).toHaveLength(1);
    const requests = [];
    page.on('request', request => {
        if (request.url().startsWith('https://admin.example/')) requests.push([request.method(), new URL(request.url()).pathname]);
    });
    page.on('dialog', dialog => dialog.accept());
    await page.locator('#create-next').click();
    await expect(page.locator('#status')).toHaveText('Schedule now exists; refresh to open it.');
    await expect(page.locator('#season')).toHaveValue('2026');
    await expect(page.locator('#week')).toHaveValue('2');
    await expect(page.locator('#week option')).toHaveText(['1','2','3']);
    await expect(page.getByLabel('Player 1 NAME',{exact:true})).toHaveValue('Preserve my edits');
    await expect(page.locator('#create-next')).toBeHidden();
    expect(creations).toBe(1);
    expect(requests).toEqual([['POST','/schedules/next'],['GET','/schedules']]);
    await expect(page.locator('#dirty')).toHaveText('Unsaved changes');
    expect(await recovery()).toEqual(retained);
    await page.locator('#week').selectOption('3');
    await expect(page.locator('#status')).toHaveText('Season 2026 · Week 3');
    await expect(page.locator('#week')).toHaveValue('3');
    await expect(page.getByLabel('Column 2 header')).toHaveValue('BUF NYJ');
    await expect(page.getByLabel('Player 1 NAME',{exact:true})).toHaveValue('');
    expect(requests).toEqual([['POST','/schedules/next'],['GET','/schedules'],['GET','/weeks/2026/3']]);
    expect(creations).toBe(1);
});

for (const action of ['create', 'publish']) {
    test(`due week ${action} confirms publication, refreshes the catalog and selects the week`, async ({page}) => {
        await authenticated(page, {unpublished:true});
        // The server's decision remains authoritative even with an incorrect browser clock.
        await page.clock.install({time:new Date('2000-01-01T00:00:00Z')});
        let completed = false, posts = 0, release;
        const requests = [];
        await page.route('https://admin.example/schedules', route => route.fulfill({json:{
            seasons:{2026:completed || action === 'publish' ? [1,2,3] : [1,2]},
            season:2026,week:completed ? 3 : 2,user_id:'commissioner',
            next_creation:completed ? {season:2026,week:4,action:'create',publish_manifest:false,token:'next'}
                : {season:2026,week:3,action,publish_manifest:true,token:'due'},
        }}));
        await page.route('https://admin.example/schedules/next', async route => {
            posts++;
            expect(route.request().postDataJSON()).toEqual({token:'due',confirm:true});
            await new Promise(resolve => { release = resolve; });
            completed = true;
            await route.fulfill({json:{season:2026,week:3,message:'Week 3 is published.'}});
        });
        await page.goto('/admin/?code=code&state=state');
        const button = page.getByRole('button', {name:`${action === 'publish' ? 'Publish' : 'Create'} Week 3`,exact:true});
        await expect(button).toBeEnabled();
        page.once('dialog', d => d.dismiss());
        await button.click(); expect(posts).toBe(0);
        page.once('dialog', d => {
            expect(d.message()).toContain(action === 'publish' ? 'without changing its schedule or picks' : 'creates the schedule and publishes');
            return d.accept();
        });
        page.on('request', r => {
            if (r.url().startsWith('https://admin.example/')) requests.push([r.method(), new URL(r.url()).pathname]);
        });
        await button.click();
        await expect(page.locator('#status')).toHaveText('Publishing week…');
        await expect(button).toBeDisabled();
        await expect.poll(() => posts).toBe(1);
        release();
        await expect(page.locator('#week')).toHaveValue('3');
        await expect(page.locator('#status')).toHaveText('Week 3 is published.');
        await expect(page.getByRole('button', {name:'Create Week 4',exact:true})).toBeVisible();
        expect(requests).toEqual([['POST','/schedules/next'],['GET','/schedules'],['GET','/weeks/2026/3']]);
        expect(posts).toBe(1);
    });
}

test('a prepared future week has no publication action even with a future browser clock', async ({page}) => {
    await authenticated(page, {unpublished:true});
    await page.route('https://admin.example/schedules', route => route.fulfill({json:{
        seasons:{2026:[1,2,3]},season:2026,week:2,user_id:'commissioner',next_creation:null,
    }}));
    await page.goto('/admin/?code=code&state=state');
    await expect(page.locator('#week')).toHaveValue('2');
    await page.clock.install({time:new Date('2030-01-01T00:00:00Z')});
    await expect(page.locator('#create-next')).toBeHidden();
    await page.locator('#week').selectOption('3');
    await expect(page.locator('#status')).toHaveText('Season 2026 · Week 3');
    await expect(page.locator('#create-next')).toBeHidden();
});

for (const completed of [false,true]) for (const dirty of [false,true]) {
    test(`uncertain publication reconciles without retry (completed=${completed}, dirty=${dirty})`, async ({page}) => {
        await authenticated(page, {unpublished:true});
        await page.clock.install();
        let attempted = false, posts = 0;
        await page.route('https://admin.example/schedules', route => route.fulfill({json:{
            seasons:{2026:[1,2,3]},season:2026,week:attempted && completed ? 3 : 2,user_id:'commissioner',
            next_creation:attempted && completed ? null : {
                season:2026,week:3,action:'publish',publish_manifest:true,token:attempted ? 'fresh' : 'due',
            },
        }}));
        await page.route('https://admin.example/schedules/next', route => {
            posts++; attempted = true;
            return route.fulfill({status:502,json:{message:'Publication was not confirmed.'}});
        });
        await page.goto('/admin/?code=code&state=state');
        await expect(page.getByRole('button', {name:'Publish Week 3',exact:true})).toBeEnabled();
        if (dirty) await page.getByLabel('Player 1 NAME',{exact:true}).fill('Keep my edits');
        const requests = [];
        page.on('request', r => {
            if (r.url().startsWith('https://admin.example/')) requests.push([r.method(), new URL(r.url()).pathname]);
        });
        page.on('dialog', d => d.accept());
        await page.locator('#create-next').click();
        await expect(page.locator('#status')).toHaveText(completed
            ? `Week 3 is published (confirmed after refresh).${dirty ? ' Your current edits are preserved.' : ''}`
            : 'Publication was not confirmed.');
        await expect(page.locator('#week')).toHaveValue(completed && !dirty ? '3' : '2');
        if (dirty) {
            await expect(page.getByLabel('Player 1 NAME',{exact:true})).toHaveValue('Keep my edits');
            await expect(page.locator('#dirty')).toHaveText('Unsaved changes');
        }
        expect(requests).toEqual([['POST','/schedules/next'],['GET','/schedules'],
            ...(completed && !dirty ? [['GET','/weeks/2026/3']] : [])]);
        expect(posts).toBe(1);
        await expect(page.locator('#create-next'))[completed ? 'toBeHidden' : 'toBeEnabled']();
    });
}

test('uncertain publication with a failed catalog refresh disables the stale action', async ({page}) => {
    await authenticated(page, {unpublished:true});
    await page.clock.install();
    let attempted = false, posts = 0;
    await page.route('https://admin.example/schedules', route => route.fulfill(attempted
        ? {status:502,json:{message:'Catalog unavailable'}}
        : {json:{seasons:{2026:[1,2,3]},season:2026,week:2,user_id:'commissioner',
            next_creation:{season:2026,week:3,action:'publish',publish_manifest:true,token:'due'}}}));
    await page.route('https://admin.example/schedules/next', route => {
        attempted = true; posts++;
        return route.abort('failed');
    });
    await page.goto('/admin/?code=code&state=state');
    await page.getByLabel('Player 1 NAME',{exact:true}).fill('Keep my edits');
    page.on('dialog', d => d.accept());
    await page.locator('#create-next').click();
    await expect(page.locator('#status')).toContainText('Refresh the portal before trying again');
    await expect(page.locator('#create-next')).toBeHidden();
    await expect(page.getByLabel('Player 1 NAME',{exact:true})).toHaveValue('Keep my edits');
    expect(posts).toBe(1);
});

test('announcement editing preserves picks and handles errors, conflicts, publication and clearing', async ({page}) => {
    await authenticated(page);
    let current = {top:{text:'Published',link:null},bottom:{text:'',link:null}};
    let etag = null, failure = 0, reads = 0;
    await page.route('https://admin.example/announcements', route => {
        expect(route.request().headers().authorization).toBe('Bearer test-access');
        if (route.request().method() === 'GET') {
            reads++;
            return route.fulfill({json:{document:current,etag}});
        }
        if (failure) return route.fulfill({status:failure,json:{message:failure === 409 ? 'Announcements changed' : 'Unavailable'}});
        const body = route.request().postDataJSON();
        expect(body.etag).toBe(etag);
        current = body.document; etag = 'v2';
        return route.fulfill({json:{document:current,etag}});
    });
    await page.getByLabel('Player 1 NAME',{exact:true}).fill('Alice');
    await page.locator('#view-announcements').click();
    await expect(page.locator('#top-text')).toHaveValue('Published');
    await expect(page.locator('#publish-announcements')).toBeDisabled();
    await page.locator('#top-text').fill('<b>Local</b>');
    await page.locator('#bottom-text').fill('Bottom');
    await expect(page.locator('#preview-top')).toHaveText('<b>Local</b>');
    await expect(page.locator('#preview-top b')).toHaveCount(0);
    await page.locator('#view-picks').click();
    await expect(page.getByLabel('Player 1 NAME',{exact:true})).toHaveValue('Alice');
    await page.locator('#view-announcements').click();
    expect(reads).toBe(1);
    await expect(page.locator('#top-text')).toHaveValue('<b>Local</b>');
    failure = 502;
    await page.locator('#publish-announcements').click();
    await expect(page.locator('#announcements-status')).toContainText('Your edits are preserved');
    await expect(page.locator('#top-text')).toHaveValue('<b>Local</b>');
    failure = 409;
    await page.locator('#publish-announcements').click();
    await expect(page.locator('#reload-announcements')).toBeVisible();
    await expect(page.locator('#publish-announcements')).toBeDisabled();
    page.once('dialog', dialog => dialog.dismiss());
    await page.locator('#reload-announcements').click();
    await expect(page.locator('#top-text')).toHaveValue('<b>Local</b>');
    page.once('dialog', dialog => dialog.accept());
    await page.locator('#reload-announcements').click();
    await expect(page.locator('#top-text')).toHaveValue('Published');
    failure = 0;
    await page.locator('#top-text').fill('New message');
    await page.locator('#publish-announcements').click();
    await expect(page.locator('#announcements-status')).toHaveText('Announcements published.');
    await expect(page.locator('#publish-announcements')).toBeDisabled();
    await page.locator('#top-text').fill('');
    await expect(page.locator('#preview-top')).toBeHidden();
    await page.locator('#publish-announcements').click();
    await expect(page.locator('#publish-announcements')).toBeDisabled();
    expect(current.top.text).toBe('');
    await page.setViewportSize({width:375,height:812});
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('announcement load failure can be retried without loading picks again', async ({page}) => {
    await authenticated(page);
    let fail = true, weeklyRequests = 0;
    page.on('request', request => { if (request.url().startsWith('https://admin.example/weeks/')) weeklyRequests++; });
    await page.route('https://admin.example/announcements', route => fail
        ? route.fulfill({status:502,json:{message:'Unable to read announcements'}})
        : route.fulfill({json:{document:{top:{text:'',link:null},bottom:{text:'',link:null}},etag:null}}));
    await page.locator('#view-announcements').click();
    await expect(page.locator('#announcements-status')).toHaveText('Unable to read announcements');
    await expect(page.locator('#publish-announcements')).toBeDisabled();
    fail = false;
    await page.locator('#reload-announcements').click();
    await expect(page.locator('#top-text')).toBeEnabled();
    await page.locator('#top-text').fill('With link');
    await page.getByText('Optional top link',{exact:true}).click();
    await page.locator('#top-label').fill('Schedule');
    await page.locator('#top-url').fill('https://example.com/schedule');
    await expect(page.locator('#preview-top a')).toHaveAttribute('href','https://example.com/schedule');
    expect(weeklyRequests).toBe(0);
});

test('active portal navigation is visible and follows the selected view on mobile', async ({page}) => {
    await page.setViewportSize({width:375,height:812});
    await authenticated(page);
    await page.route('https://admin.example/announcements', route => route.fulfill({json:{document:{top:{text:'',link:null},bottom:{text:'',link:null}},etag:null}}));
    const picks = page.locator('#view-picks'), announcements = page.locator('#view-announcements');
    async function active(selected, inactive) {
        await expect(selected).toHaveAttribute('aria-pressed','true');
        await expect(inactive).toHaveAttribute('aria-pressed','false');
        await expect(selected).toHaveCSS('background-color','rgb(82, 111, 105)');
        await expect(selected).toHaveCSS('color','rgb(246, 241, 232)');
        await expect(inactive).toHaveCSS('color','rgb(111, 119, 114)');
        await expect(selected).toBeInViewport();
        await expect(inactive).toBeInViewport();
    }
    await active(picks, announcements);
    await announcements.click();
    await active(announcements, picks);
    await picks.click();
    await active(picks, announcements);
});

test('full roster edits retain recovery synchronously without rescanning controls or requesting data', async ({page}) => {
    const games = Array.from({length:16}, (_, i) => ({id:`game${i}`,away:`A${i}`,home:`H${i}`}));
    const headers = ['NAME', ...games.map(g => `${g.away} ${g.home}`), 'TIEBREAKER'];
    const rows = Array.from({length:55}, (_, i) => [`Player ${i}`, ...games.map(g => g.away), '30']);
    await authenticated(page, {games, headers, rows});
    await page.clock.install();
    const requests = [];
    page.on('request', request => requests.push(request.url()));
    const result = await page.evaluate(() => {
        let scans = 0, writes = 0;
        const query = document.querySelectorAll.bind(document), setItem = Storage.prototype.setItem;
        document.querySelectorAll = selector => {
            if (selector === '#editor button, #editor select, #editor input') scans++;
            return query(selector);
        };
        Storage.prototype.setItem = function(key, value) { writes++; return setItem.call(this, key, value); };
        const input = document.querySelector('[data-row="0"][data-column="0"]');
        const start = performance.now();
        for (let i = 0; i < 20; i++) {
            input.value = `Typing ${i}`; input.dispatchEvent(new Event('input'));
            const key = Object.keys(localStorage).find(key => key.endsWith('.2026.2'));
            if (JSON.parse(localStorage.getItem(key)).table.rows[0][0] !== input.value) throw new Error('Recovery lagged');
        }
        return {scans, writes, ms:performance.now() - start};
    });
    console.log('55-player, 16-game typing:', result);
    expect(result.scans).toBe(0);
    expect(result.writes).toBe(20);
    expect(requests).toEqual([]);
    await expect(page.locator('#save')).toBeEnabled();
    await expect(page.locator('#revert')).toBeVisible();
    await page.getByLabel('Player 56 NAME', {exact:true}).fill('New Player');
    await expect(page.locator('#picks tbody tr')).toHaveCount(57);
    await page.getByRole('button', {name:'Remove player 56',exact:true}).click();
    await expect(page.locator('#picks tbody tr')).toHaveCount(56);
    await page.clock.fastForward(3000);
    await expect(page.locator('#dirty')).toHaveText('All changes saved');
    expect(requests.filter(url => url.endsWith('/draft'))).toHaveLength(1);
});

for (const stage of ['token', 'catalog', 'week']) {
    test(`sign-in handoff stays private while ${stage} is pending`, async ({page}) => {
        let release;
        const pending = new Promise(resolve => { release = resolve; });
        const target = stage === 'token' ? 'https://login.example/oauth2/token'
            : stage === 'catalog' ? 'https://admin.example/schedules' : 'https://admin.example/weeks/2026/2';
        await authenticated(page, {waitForReady:false, intercept:async (route, next) => {
            if (route.request().url() === target) await pending;
            return next();
        }});
        await expect(page.locator('#status')).toHaveText(stage === 'token' ? 'Completing sign-in…' : 'Signed in. Loading commissioner portal…');
        await expect(page.locator('#login')).toBeVisible();
        await expect(page.locator('#login')).toBeDisabled();
        await expect(page.locator('#login')).toHaveText('Signing in ...');
        for (const id of ['editor', 'portal-nav', 'logout', 'announcements-view']) await expect(page.locator('#' + id)).toBeHidden();
        await page.locator('#login').evaluate(button => { button.click(); button.click(); });
        release();
        await expect(page.locator('#editor')).toBeVisible();
        await expect(page.locator('#login')).toBeHidden();
        await expect(page.locator('#logout')).toBeVisible();
    });
}

for (const stage of ['catalog', 'week', 'identity', 'expired', 'exchange', 'declined']) {
    test(`sign-in ${stage} failure offers appropriate recovery`, async ({page}) => {
        let failed = true, tokens = 0;
        const requests = [];
        let releaseRetry;
        const retryPending = new Promise(resolve => { releaseRetry = resolve; });
        const intercept = async (route, next) => {
            const path = new URL(route.request().url()).pathname;
            requests.push(path);
            if (path === '/oauth2/token') {
                tokens++;
                if (stage === 'exchange') return route.fulfill({status:400,json:{}});
            }
            if (failed && ((stage === 'catalog' && path === '/schedules') || (stage === 'week' && path.startsWith('/weeks/')))) return route.fulfill({status:503,json:{message:'Temporarily unavailable'}});
            if (stage === 'identity' && path === '/schedules') return route.fulfill({json:{seasons:{2026:[2]},season:2026,week:2}});
            if (stage === 'expired' && path === '/schedules') return route.fulfill({status:403,json:{}});
            if (!failed && path === '/schedules') await retryPending;
            return next();
        };
        // Set up mocks without waiting for a ready editor on this failed visit.
        await authenticated(page, {waitForReady:false, intercept});
        if (stage === 'declined') {
            await expect(page.locator('#editor')).toBeVisible();
            await page.goto('/admin/?error=access_denied');
        }
        const retry = stage === 'catalog' || stage === 'week' || stage === 'identity';
        await expect(page.locator('#status')).toContainText(retry ? 'Unable to load commissioner portal' : stage === 'exchange' ? 'Sign-in exchange failed' : stage === 'declined' ? 'Sign-in was declined' : 'Session expired');
        await expect(page.locator('#editor')).toBeHidden();
        await expect(page.locator('#login')).toBeVisible();
        await expect(page.locator('#login')).toBeEnabled();
        await expect(page.locator('#login')).toHaveText(retry ? 'Retry loading portal' : stage === 'expired' ? 'Sign in to continue' : 'Sign in');
        if (stage === 'catalog' || stage === 'week') {
            failed = false;
            await page.locator('#login').evaluate(button => { button.click(); button.click(); });
            await expect(page.locator('#login')).toBeVisible();
            await expect(page.locator('#login')).toBeDisabled();
            await expect(page.locator('#login')).toHaveText('Signing in ...');
            await expect(page.locator('#status')).toHaveText('Signed in. Loading commissioner portal…');
            releaseRetry();
            await expect(page.locator('#editor')).toBeVisible();
            await expect(page.locator('#login')).toBeHidden();
            expect(tokens).toBe(1);
            expect(requests.filter(path => path === '/schedules')).toHaveLength(2);
            expect(requests.filter(path => path.startsWith('/weeks/'))).toHaveLength(stage === 'catalog' ? 1 : 2);
        }
    });
}

test('repeated sign-in clicks start only one authorization request', async ({page}) => {
    await page.route('**/assets/admin-config.json', route => route.fulfill({json:{domain:'https://login.example',clientId:'spa',redirectUri:'http://127.0.0.1:8000/admin/'}}));
    await page.addInitScript(() => {
        const digest = crypto.subtle.digest.bind(crypto.subtle);
        window.digestCalls = 0;
        crypto.subtle.digest = async (...args) => {
            window.digestCalls++;
            await new Promise(resolve => { window.releaseDigest = resolve; });
            return digest(...args);
        };
    });
    let authorizations = 0;
    await page.route('https://login.example/**', route => {
        authorizations++;
        return route.fulfill({body:'Managed login'});
    });
    await page.goto('/admin/');
    await expect(page.locator('#status')).toContainText('Sign in with');
    await page.locator('#login').evaluate(button => { button.click(); button.click(); });
    await expect(page.locator('#login')).toBeVisible();
    await expect(page.locator('#login')).toBeDisabled();
    await expect(page.locator('#login')).toHaveText('Signing in ...');
    await expect(page.locator('#status')).toHaveText('Opening sign-in…');
    expect(await page.evaluate(() => window.digestCalls)).toBe(1);
    await page.evaluate(() => window.releaseDigest());
    await page.waitForURL('https://login.example/**');
    expect(authorizations).toBe(1);
});

test('failed sign-in initiation restores the sign-in button', async ({page}) => {
    await page.route('**/assets/admin-config.json', route => route.fulfill({json:{domain:'https://login.example'}}));
    await page.addInitScript(() => {
        crypto.subtle.digest = async () => { throw new Error('Unable to start sign-in'); };
    });
    await page.goto('/admin/');
    await expect(page.locator('#status')).toContainText('Sign in with');
    await page.locator('#login').click();
    await expect(page.locator('#status')).toHaveText('Unable to start sign-in');
    await expect(page.locator('#login')).toBeVisible();
    await expect(page.locator('#login')).toBeEnabled();
    await expect(page.locator('#login')).toHaveText('Sign in');
});
