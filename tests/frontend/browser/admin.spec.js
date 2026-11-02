import {test, expect} from '@playwright/test';

async function authenticated(page, {user = 'commissioner', etag = null, rows = []} = {}) {
    await page.route('**/assets/admin-config.json', route => route.fulfill({json:{api:'https://admin.example',domain:'https://login.example',clientId:'spa',redirectUri:'http://127.0.0.1:8000/admin/'}}));
    await page.route('https://login.example/oauth2/token', route => route.fulfill({json:{access_token:'test-access',refresh_token:'test-refresh',expires_in:1800}}));
    await page.route('https://admin.example/**', route => {
        expect(route.request().headers().authorization).toBe('Bearer test-access');
        const path = new URL(route.request().url()).pathname;
        if (path === '/schedules') return route.fulfill({json:{seasons:{2026:[1,2,3]},season:2026,week:2,user_id:user}});
        if (path.endsWith('/3')) return route.fulfill({status:404,json:{message:'No schedule available for the selected week'}});
        if (path.endsWith('/draft')) return route.fulfill({json:{etag:'saved',issues:[]}});
        if (path.endsWith('/submit')) return route.fulfill({json:{etag:'submitted',issues:[],message:'Picks submitted and processed',result:{status:'ok'}}});
        return route.fulfill({json:{games:[{id:'game',away:path.includes('/1')?'JAX':'NE',home:path.includes('/1')?'WSH':'SEA'}],headers:['NAME',path.includes('/1')?'JAX WSH':'NE SEA','TIEBREAKER'], rows, etag, issues:[]}});
    });
    await page.addInitScript(() => sessionStorage.setItem('pbj.pkce', JSON.stringify({verifier:'verifier',state:'state',created:Date.now()})));
    await page.goto('/admin/?code=code&state=state');
    await expect(page.locator('#editor')).toBeVisible();
}
test('public shell requires sign-in', async ({page}) => {
    await page.goto('/admin/');
    await expect(page.locator('#editor')).toBeHidden();
    await expect(page.getByRole('button',{name:'Sign in',exact:true})).toBeVisible();
});
test('current default, editing, draft save and schedule switching', async ({page}) => {
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
test('CSV upload is editable and submit requires confirmation', async ({page}) => {
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

test('offline edits survive reload and reauthentication but restoration never autosaves', async ({page}) => {
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
    await authenticated(page, {etag:'old',rows:[['Alice','SEA','30']]});
    const name = page.getByLabel('Player 1 NAME',{exact:true});
    await name.fill('Temporary'); await name.fill('Alice');
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
    await authenticated(page, {rows:[['Alice','SEA','42.5'],['Bob','N/P','0']]});
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
    await authenticated(page, {rows:[['Alice','SEA','42.5'],['Bob','N/P','0']]});
    await expect(page.locator('#recovery')).toBeVisible();
    await expect(page.getByLabel('Player 1 TIEBREAKER',{exact:true})).toHaveValue('42.5');
    await page.locator('#restore-device').click();
    await expect(page.getByLabel('Player 1 TIEBREAKER',{exact:true})).toHaveValue('50');
});
