import {test, expect} from '@playwright/test';

async function authenticated(page) {
    await page.route('**/assets/admin-config.json', route => route.fulfill({json:{api:'https://admin.example',domain:'https://login.example',clientId:'spa',redirectUri:'http://127.0.0.1:8000/admin/'}}));
    await page.route('https://login.example/oauth2/token', route => route.fulfill({json:{access_token:'test-access'}}));
    await page.route('https://admin.example/**', route => {
        expect(route.request().headers().authorization).toBe('Bearer test-access');
        const path = new URL(route.request().url()).pathname;
        if (path === '/schedules') return route.fulfill({json:{seasons:{2026:[1,2,3]},season:2026,week:2}});
        if (path.endsWith('/3')) return route.fulfill({status:404,json:{message:'No schedule available for the selected week'}});
        if (path.endsWith('/draft')) return route.fulfill({json:{etag:'saved',issues:[]}});
        if (path.endsWith('/submit')) return route.fulfill({json:{etag:'submitted',issues:[],message:'Picks submitted and processed',result:{status:'ok'}}});
        return route.fulfill({json:{headers:['NAME',path.includes('/1')?'JAX WSH':'NE SEA','TIEBREAKER'], rows:[], etag:null, issues:[]}});
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
    await expect(page.locator('#week')).toHaveValue('2');
    await expect(page.getByLabel('Column 2 header')).toHaveValue('NE SEA');
    await page.getByRole('button',{name:'Add player',exact:true}).click();
    await page.getByLabel('Player 1 NAME',{exact:true}).fill('Alice');
    page.once('dialog', dialog => dialog.dismiss());
    await page.locator('#week').selectOption('1');
    await expect(page.locator('#week')).toHaveValue('2');
    await page.getByRole('button',{name:'Save Draft',exact:true}).click();
    await expect(page.locator('#status')).toHaveText('Draft saved privately');
    await page.locator('#week').selectOption('1');
    await expect(page.getByLabel('Column 2 header')).toHaveValue('JAX WSH');
    await expect(page.locator('#picks tbody tr')).toHaveCount(0);
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
    await page.getByRole('button',{name:'Add player',exact:true}).click();
    await expect(page.getByLabel('Player 1 NAME',{exact:true})).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
test('cell diagnostics clear after correction and conflicts preserve edits', async ({page}) => {
    await authenticated(page);
    await page.getByRole('button',{name:'Add player',exact:true}).click();
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
    await expect(page.locator('#dirty')).toHaveText('Unsaved changes');
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
        await expect(page.locator('#picks tbody tr')).toHaveCount(2);
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
        page.once('dialog', dialog => dialog.accept());
        await page.locator('#headers').click();
        await expect(page.locator('#headers')).toBeEnabled();
        if (csv.includes('extra')) {
            await expect(page.locator('#status')).toContainText('Header repair stopped; no data changed');
            await expect(page.locator('[data-row="0"][data-column="3"]')).toHaveValue('extra');
        }
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
    ['extra cell', 'NAME,NE SEA,TIEBREAKER\nAlice,SEA,30,keep me\n', 'column 4 is populated beyond', null],
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
            page.once('dialog', dialog => dialog.accept());
            await page.locator('#headers').click();
            await expect(page.locator('#headers')).toBeEnabled();
            await expect(page.locator('#status')).toHaveText('Schedule headers repaired.');
            expect(await values()).toEqual(['NAME','NE SEA','TIEBREAKER','Alice','SEA','30']);
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
    expect(await page.locator('#picks tbody input').evaluateAll(inputs => inputs.map(input => input.value))).toEqual(['Alice','SEA','30']);
});
