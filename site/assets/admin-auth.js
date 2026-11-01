const encode = bytes => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
export async function beginLogin(config) {
    const verifier = encode(crypto.getRandomValues(new Uint8Array(32)));
    const state = encode(crypto.getRandomValues(new Uint8Array(32)));
    sessionStorage.setItem('pbj.pkce', JSON.stringify({verifier, state, created: Date.now()}));
    const challenge = encode(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
    const url = new URL('/oauth2/authorize', config.domain);
    url.search = new URLSearchParams({response_type: 'code', client_id: config.clientId,
        redirect_uri: config.redirectUri, scope: 'openid pbj/admin', state,
        code_challenge_method: 'S256', code_challenge: challenge});
    location.assign(url);
}
export async function finishLogin(config) {
    const params = new URLSearchParams(location.search);
    if (params.has('error')) {
        history.replaceState(null, '', location.pathname);
        sessionStorage.removeItem('pbj.pkce');
        throw new Error('Sign-in was declined. Please try again.');
    }
    if (!params.has('code')) return null;
    const saved = JSON.parse(sessionStorage.getItem('pbj.pkce') || 'null');
    sessionStorage.removeItem('pbj.pkce');
    history.replaceState(null, '', location.pathname);
    if (!saved || params.get('state') !== saved.state || Date.now() - saved.created > 600000) throw new Error('Invalid or expired login state. Sign in again.');
    const response = await fetch(new URL('/oauth2/token', config.domain), {method: 'POST',
        headers: {'Content-Type': 'application/x-www-form-urlencoded'}, body: new URLSearchParams({
            grant_type: 'authorization_code', client_id: config.clientId, redirect_uri: config.redirectUri,
            code: params.get('code'), code_verifier: saved.verifier})});
    if (!response.ok) throw new Error('Sign-in exchange failed. Please sign in again.');
    return (await response.json()).access_token;
}
