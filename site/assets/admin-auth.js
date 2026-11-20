async function tokenJSON(response) {
  try {
    return await response.json();
  } catch {
    throw new Error("Unable to read the sign-in response. Please try again.");
  }
}
const encode = (bytes) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
export async function beginLogin(config) {
  const verifier = encode(crypto.getRandomValues(new Uint8Array(32)));
  const state = encode(crypto.getRandomValues(new Uint8Array(32)));
  sessionStorage.setItem(
    "pbj.pkce",
    JSON.stringify({ verifier, state, created: Date.now() }),
  );
  const challenge = encode(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
    ),
  );
  const url = new URL("/oauth2/authorize", config.domain);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    scope: "openid pbj/admin",
    state,
    code_challenge_method: "S256",
    code_challenge: challenge,
  });
  location.assign(url);
}
export async function finishLogin(config) {
  const params = new URLSearchParams(location.search);
  if (params.has("error")) {
    history.replaceState(null, "", location.pathname);
    sessionStorage.removeItem("pbj.pkce");
    throw new Error("Sign-in was declined. Please try again.");
  }
  if (!params.has("code")) return null;
  const saved = JSON.parse(sessionStorage.getItem("pbj.pkce") || "null");
  sessionStorage.removeItem("pbj.pkce");
  history.replaceState(null, "", location.pathname);
  if (
    !saved ||
    params.get("state") !== saved.state ||
    Date.now() - saved.created > 600000
  )
    throw new Error("Invalid or expired login state. Sign in again.");
  const response = await fetch(new URL("/oauth2/token", config.domain), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: config.clientId,
      redirect_uri: config.redirectUri,
      code: params.get("code"),
      code_verifier: saved.verifier,
    }),
  });
  if (!response.ok)
    throw new Error("Sign-in exchange failed. Please sign in again.");
  return tokenJSON(response);
}

export class SessionExpired extends Error {
  constructor() {
    super("Session expired — sign in to continue");
  }
}

/** Credentials live only in this closure; API Gateway verifies their identity. */
export function createSession(
  config,
  initial,
  { fetcher = fetch, now = Date.now } = {},
) {
  let access,
    refresh,
    expires = 0,
    renewing = null,
    generation = 0;
  function accept(tokens) {
    if (
      !tokens.access_token ||
      !Number.isFinite(tokens.expires_in) ||
      tokens.expires_in <= 0
    )
      throw new SessionExpired();
    access = tokens.access_token;
    refresh = tokens.refresh_token || refresh;
    expires = now() + tokens.expires_in * 1000;
  }
  accept(initial);
  function clear() {
    generation++;
    access = refresh = null;
    expires = 0;
  }
  async function renew() {
    if (renewing) return renewing;
    if (!refresh) throw new SessionExpired();
    const current = generation;
    renewing = (async () => {
      const response = await fetcher(new URL("/oauth2/token", config.domain), {
        method: "POST",
        cache: "no-store",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: config.clientId,
          refresh_token: refresh,
        }),
      });
      if (current !== generation) throw new SessionExpired();
      if (!response.ok) {
        if (response.status < 500 && response.status !== 429) {
          clear();
          throw new SessionExpired();
        }
        throw new Error("Unable to reconnect. Your edits are still here.");
      }
      const tokens = await tokenJSON(response);
      if (current !== generation) throw new SessionExpired();
      accept(tokens);
    })().finally(() => {
      renewing = null;
    });
    return renewing;
  }
  return {
    clear,
    async request(url, options = {}) {
      if (!access) throw new SessionExpired();
      if (now() >= expires - 60000) await renew();
      const used = access;
      const send = () =>
        fetcher(url, {
          ...options,
          headers: { ...options.headers, Authorization: `Bearer ${access}` },
        });
      let response = await send();
      // A rejected JWT has not reached the integration. Never replay network failures or 5xx responses.
      if (response.status === 401) {
        if (used === access) await renew();
        response = await send();
      }
      if (response.status === 401 || response.status === 403) {
        clear();
        throw new SessionExpired();
      }
      return response;
    },
  };
}
