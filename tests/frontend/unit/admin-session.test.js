import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createSession,
  SessionExpired,
} from "../../../site/assets/admin-auth.js";
import {
  createDraft,
  recoveryScope,
  recoveryKey,
  readRecovery,
} from "../../../site/assets/admin-draft.js";
import {
  matchupFor,
  needsHeaderRepair,
} from "../../../site/assets/admin-model.js";
const config = {
  domain: "https://login.example",
  clientId: "spa",
  api: "https://api.example",
};
const tokens = {
  access_token: "original",
  refresh_token: "refresh",
  expires_in: 1800,
};
const response = (status, body = {}) =>
  new Response(JSON.stringify(body), { status });
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

test("refresh before expiry uses one request and retains refresh token only in memory", async () => {
  let now = 0,
    refreshes = 0;
  const gate = deferred(),
    seen = [];
  const session = createSession(config, tokens, {
    now: () => now,
    fetcher: async (url, options) => {
      if (String(url).includes("/oauth2/token")) {
        refreshes++;
        assert.equal(options.body.get("grant_type"), "refresh_token");
        assert.equal(options.body.get("refresh_token"), "refresh");
        await gate.promise;
        return response(200, { access_token: "renewed", expires_in: 1800 });
      }
      seen.push(options.headers.Authorization);
      return response(200);
    },
  });
  now = 1800000;
  const requests = [session.request("/one"), session.request("/two")];
  gate.resolve();
  await Promise.all(requests);
  assert.equal(refreshes, 1);
  assert.deepEqual(seen, ["Bearer renewed", "Bearer renewed"]);
  now += 1800000;
  await session.request("/three");
  assert.equal(refreshes, 2);
  session.clear();
  await assert.rejects(session.request("/four"), SessionExpired);
});
test("simultaneous rejected JWTs share renewal and replay each request at most once", async () => {
  let refreshes = 0;
  const calls = [];
  const session = createSession(config, tokens, {
    fetcher: async (url, options) => {
      if (String(url).includes("/oauth2/token")) {
        refreshes++;
        return response(200, { access_token: "renewed", expires_in: 1800 });
      }
      calls.push(options.headers.Authorization);
      return response(
        options.headers.Authorization.endsWith("original") ? 401 : 200,
      );
    },
  });
  await Promise.all([session.request("/one"), session.request("/two")]);
  assert.equal(refreshes, 1);
  assert.equal(calls.length, 4);
});
test("failed refresh expires session without leaking credential response details", async () => {
  let calls = 0;
  const session = createSession(config, tokens, {
    fetcher: async (url) => {
      calls++;
      return String(url).includes("/oauth2/token")
        ? response(400, { error_description: "secret" })
        : response(401);
    },
  });
  await assert.rejects(
    session.request("/one"),
    (error) =>
      error instanceof SessionExpired && !error.message.includes("secret"),
  );
  await assert.rejects(session.request("/two"), SessionExpired);
  assert.equal(calls, 2);
});
test("network and server failures never replay a submission; forbidden identity fails closed", async () => {
  for (const failure of ["network", 502, 403]) {
    let calls = 0;
    const session = createSession(config, tokens, {
      fetcher: async () => {
        calls++;
        if (failure === "network") throw new TypeError("offline");
        return response(failure);
      },
    });
    try {
      await session.request("/submit", { method: "POST" });
    } catch {
      /* Expected failure. */
    }
    assert.equal(calls, 1);
    if (failure === 403)
      await assert.rejects(session.request("/one"), SessionExpired);
  }
});
function draftHarness(write, options = {}) {
  const data = new Map(),
    events = [];
  const storage = {
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => data.set(k, v),
    removeItem: (k) => data.delete(k),
  };
  let callback;
  const draft = createDraft({
    key: "draft",
    storage,
    etag: "base",
    write,
    ...options,
    notify: (...event) => events.push(event),
    schedule: (fn) => {
      callback = fn;
    },
    cancel: () => {
      callback = null;
    },
  });
  return { draft, data, events, storage, tick: () => callback?.() };
}
const table = {
  headers: ["NAME", "NE SEA", "TIEBREAKER"],
  rows: [["Alice", "", ""]],
};
test("debounced saves serialize writes and retain edits made while a write is pending", async () => {
  const gate = deferred(),
    writes = [];
  const h = draftHarness(async (value, etag) => {
    writes.push({ value, etag });
    if (writes.length === 1) await gate.promise;
    return { etag: "version" + writes.length };
  });
  h.draft.edit(table);
  h.tick();
  await Promise.resolve();
  const pending = h.draft.pending;
  const next = structuredClone(table);
  next.rows[0][1] = "SEA";
  h.draft.edit(next);
  h.tick();
  assert.equal(writes.length, 1);
  gate.resolve();
  await pending;
  // Flush the successful completion's queued next save.
  await Promise.resolve();
  h.tick();
  await h.draft.pending;
  assert.equal(writes.length, 2);
  assert.equal(writes[1].etag, "version1");
  assert.equal(writes[1].value.rows[0][1], "SEA");
  assert.equal(h.draft.dirty, false);
  assert.equal(h.data.size, 0);
});
test("offline and conflict saves preserve exact partial data and never advance ETags on failure", async () => {
  for (const status of [0, 409]) {
    let calls = 0;
    const h = draftHarness(async () => {
      calls++;
      throw Object.assign(new Error("failed"), { status });
    });
    h.draft.edit(table);
    await assert.rejects(h.draft.save());
    assert.equal(h.draft.etag, "base");
    assert.equal(h.draft.dirty, true);
    assert.deepEqual(readRecovery(h.storage, "draft").table, table);
    h.tick();
    assert.equal(calls, 1);
    if (status === 409) await assert.rejects(h.draft.save(), /newer draft/);
  }
});
test("recovery requires deliberate saving and keys isolate users, services and weeks", async () => {
  let calls = 0;
  const h = draftHarness(async () => {
    calls++;
    return { etag: "saved" };
  });
  h.draft.recover({ table, etag: "base" });
  h.tick();
  assert.equal(calls, 0);
  await h.draft.save();
  assert.equal(calls, 1);
  assert.notEqual(recoveryScope(config, "alice"), recoveryScope(config, "bob"));
  assert.notEqual(
    recoveryScope(config, "alice"),
    recoveryScope({ ...config, api: "other" }, "alice"),
  );
  assert.notEqual(
    recoveryKey("scope", { season: 2026, week: 1 }),
    recoveryKey("scope", { season: 2026, week: 2 }),
  );
});
test("storage failure is reported and successful server save still works", async () => {
  const events = [];
  const draft = createDraft({
    key: "key",
    etag: null,
    storage: {
      setItem: () => {
        throw Error("quota");
      },
      getItem: () => null,
    },
    write: async () => ({ etag: "saved" }),
    notify: (...args) => events.push(args),
  });
  draft.edit(table);
  assert.ok(events.some(([state]) => state === "storage"));
  await draft.save();
  assert.equal(draft.dirty, false);
  draft.dispose();
});
test("schedule objects determine orientation while accepted aliases and reversals need no repair", () => {
  const games = [{ id: "a", away: "JAX", home: "WSH" }],
    expected = ["NAME", "JAX WSH", "TIEBREAKER"];
  for (const header of ["WSH JAX", "WAS JAC", " jac was "]) {
    const headers = ["NAME", header, "TIEBREAKER"];
    assert.deepEqual(matchupFor(header, headers, games), games[0]);
    assert.equal(
      needsHeaderRepair(
        { headers, rows: [["Alice", "WAS", "30", "extra"]] },
        expected,
      ),
      false,
    );
  }
  const headers = ["NAME", "JAC WAS", "WSH JAX", "TIEBREAKER"];
  assert.equal(matchupFor("JAC WAS", headers, games), null);
  assert.equal(needsHeaderRepair({ headers, rows: [] }, expected), true);
  assert.equal(
    needsHeaderRepair({ headers, rows: [], needsHeaderChoice: true }, expected),
    false,
  );
});

test("reserved CSV headers still require canonical case and a leading NAME", () => {
  const expected = ["NAME", "NE SEA", "TIEBREAKER"];
  for (const headers of [
    ["name", "NE SEA", "TIEBREAKER"],
    ["NAME", "NE SEA", "tiebreaker"],
    ["NE SEA", "NAME", "TIEBREAKER"],
  ]) {
    assert.equal(needsHeaderRepair({ headers, rows: [] }, expected), true);
  }
});

for (const original of ["old", "base", null]) {
  test(`recovery retains ${original} provenance across edits and reload until a confirmed write`, async () => {
    const writes = [],
      h = draftHarness(async (value, etag) => {
        writes.push({ value, etag });
        return { etag: "resolved" };
      });
    h.draft.recover({ table, etag: original });
    assert.equal(h.draft.etag, "base");
    assert.equal(readRecovery(h.storage, "draft").etag, original);
    const edited = structuredClone(table);
    edited.rows[0][2] = "42";
    h.draft.edit(edited);
    h.tick();
    assert.equal(writes.length, 0);
    const record = readRecovery(h.storage, "draft");
    const reloaded = createDraft({
      key: "draft",
      storage: h.storage,
      etag: "latest",
      write: async (value, etag) => {
        writes.push({ value, etag });
        return { etag: "resolved" };
      },
      notify: () => {},
    });
    reloaded.recover(record);
    assert.equal(readRecovery(h.storage, "draft").etag, original);
    await reloaded.save();
    assert.equal(writes[0].etag, "latest");
    assert.deepEqual(writes[0].value, edited);
    assert.equal(h.data.size, 0);
    reloaded.edit(edited);
    assert.equal(readRecovery(h.storage, "draft").etag, "resolved");
    reloaded.dispose();
    h.draft.dispose();
  });
}
for (const status of [0, 409, 502]) {
  test(`failed recovered save (${status}) retains old provenance and current conditional version`, async () => {
    let written;
    const h = draftHarness(async (_, etag) => {
      written = etag;
      throw Object.assign(new Error("failed"), { status });
    });
    h.draft.recover({ table, etag: "old" });
    await assert.rejects(h.draft.save());
    assert.equal(written, "base");
    assert.equal(h.draft.etag, "base");
    assert.equal(h.draft.dirty, true);
    assert.equal(readRecovery(h.storage, "draft").etag, "old");
    assert.deepEqual(readRecovery(h.storage, "draft").table, table);
    assert.equal(Boolean(h.draft.pending), false);
    h.draft.dispose();
  });
}
test("clean saves do not write or announce persistence", async () => {
  const h = draftHarness(() => {
    throw Error("unexpected write");
  });
  assert.equal(await h.draft.save(), undefined);
  assert.deepEqual(h.events, []);
});

for (const etag of ["base", null]) {
  test(`revert restores session baseline with original draft ${etag}`, async () => {
    const data = new Map(),
      writes = [],
      deletes = [];
    const storage = {
      getItem: (k) => data.get(k),
      setItem: (k, v) => data.set(k, v),
      removeItem: (k) => data.delete(k),
    };
    const draft = createDraft({
      key: "key",
      storage,
      etag,
      initial: table,
      notify: () => {},
      write: async (value, version) => {
        writes.push({ value, version });
        return { etag: "saved" };
      },
      erase: async (version) => {
        deletes.push(version);
      },
    });
    const edited = { ...table, rows: [["Bob", "SEA", "30"]] };
    assert.equal(draft.changed, false);
    draft.edit(edited);
    assert.equal(draft.changed, true);
    assert.deepEqual(await draft.revert(), table);
    assert.equal(writes.length, 0);
    assert.equal(deletes.length, 0);
    draft.edit(edited);
    await draft.save();
    assert.equal(draft.dirty, false);
    assert.equal(draft.changed, true);
    assert.deepEqual(await draft.revert(), table);
    assert.equal(draft.changed, false);
    assert.equal(draft.dirty, false);
    assert.equal(data.size, 0);
    if (etag) {
      assert.equal(writes.length, 2);
      assert.deepEqual(writes[1], { value: table, version: "saved" });
    } else {
      assert.deepEqual(deletes, ["saved"]);
      assert.equal(draft.etag, null);
    }
    draft.dispose();
  });
}
test("revert waits for pending writes and preserves recoverable work on conflicts", async () => {
  const gate = deferred(),
    data = new Map();
  let deleted;
  const storage = {
    getItem: (k) => data.get(k),
    setItem: (k, v) => data.set(k, v),
    removeItem: (k) => data.delete(k),
  };
  const draft = createDraft({
    key: "key",
    storage,
    etag: null,
    initial: table,
    notify: () => {},
    write: async () => {
      await gate.promise;
      return { etag: "saved" };
    },
    erase: async (etag) => {
      deleted = etag;
      throw Object.assign(Error("conflict"), { status: 409 });
    },
  });
  const edited = { ...table, rows: [["Bob", "", ""]] };
  draft.edit(edited);
  const save = draft.save(),
    revert = draft.revert();
  assert.equal(deleted, undefined);
  gate.resolve();
  await save;
  await assert.rejects(revert, /conflict/);
  assert.equal(deleted, "saved");
  assert.equal(draft.changed, true);
  assert.deepEqual(readRecovery(storage, "key").table, edited);
  draft.dispose();
});

for (const serverEtag of [null, "unconfirmed"]) {
  test(`uncertain initial save reads the server before reverting (${serverEtag})`, async () => {
    const data = new Map(),
      deletes = [];
    let reads = 0;
    const storage = {
      getItem: (k) => data.get(k),
      setItem: (k, v) => data.set(k, v),
      removeItem: (k) => data.delete(k),
    };
    const draft = createDraft({
      key: "key",
      storage,
      etag: null,
      initial: table,
      notify: () => {},
      read: async () => {
        reads++;
        return { etag: serverEtag };
      },
      write: async () => {
        throw Error("connection lost");
      },
      erase: async (etag) => {
        deletes.push(etag);
      },
    });
    const edited = { ...table, rows: [["Uncertain", "", ""]] };
    draft.edit(edited);
    await assert.rejects(draft.save(), /connection lost/);
    if (serverEtag) {
      await assert.rejects(draft.revert(), /Reopen Saved Draft/);
      assert.equal(draft.etag, serverEtag);
      assert.equal(draft.blocked, true);
      assert.deepEqual(readRecovery(storage, "key").table, edited);
    } else {
      assert.deepEqual(await draft.revert(), table);
      assert.equal(draft.changed, false);
      assert.equal(draft.dirty, false);
      assert.equal(data.size, 0);
    }
    assert.equal(reads, 1);
    assert.deepEqual(deletes, []);
    draft.dispose();
  });
}
for (const etag of ["original", null]) {
  test(`manual return to baseline retains revert until persistence is reconciled (${etag})`, async () => {
    const h = draftHarness(async () => ({ etag: "saved" }));
    const deletes = [];
    const draft = createDraft({
      key: "key",
      storage: h.storage,
      etag,
      initial: table,
      notify: () => {},
      write: async () => ({ etag: "saved" }),
      erase: async (value) => deletes.push(value),
    });
    draft.edit({ ...table, rows: [["Changed", "", ""]] });
    await draft.save();
    draft.edit(table);
    assert.equal(draft.changed, true);
    await draft.revert();
    assert.equal(draft.changed, false);
    assert.deepEqual(deletes, etag ? [] : ["saved"]);
    draft.dispose();
  });
}

test("failed server check retains recovery and can be retried safely", async () => {
  const data = new Map();
  let reads = 0;
  const storage = {
    getItem: (k) => data.get(k),
    setItem: (k, v) => data.set(k, v),
    removeItem: (k) => data.delete(k),
  };
  const draft = createDraft({
    key: "key",
    storage,
    etag: null,
    initial: table,
    notify: () => {},
    write: async () => {
      throw Error("save failed");
    },
    read: async () => {
      if (++reads === 1) throw Error("read failed");
      return { etag: null };
    },
    erase: async () => {
      assert.fail("Unconfirmed writes cannot be deleted");
    },
  });
  const edited = { ...table, rows: [["Recoverable", "", ""]] };
  draft.edit(edited);
  await assert.rejects(draft.save(), /save failed/);
  await assert.rejects(draft.revert(), /read failed/);
  assert.deepEqual(readRecovery(storage, "key").table, edited);
  assert.equal(draft.changed, true);
  assert.deepEqual(await draft.revert(), table);
  assert.equal(draft.changed, false);
  draft.dispose();
});
test("a confirmed autosave of the original draft baseline finishes reconciliation", async () => {
  const h = draftHarness(async () => ({ etag: "saved" }));
  const draft = createDraft({
    key: "key",
    storage: h.storage,
    etag: "original",
    initial: table,
    notify: () => {},
    write: async () => ({ etag: "saved" }),
  });
  draft.edit({ ...table, rows: [["Edited", "", ""]] });
  await draft.save();
  draft.edit(table);
  assert.equal(draft.changed, true);
  await draft.save();
  assert.equal(draft.changed, false);
  draft.dispose();
});

test("a deleted existing draft cannot be treated as an uncertain initial save", async () => {
  const h = draftHarness(async () => ({ etag: "saved" }));
  const draft = createDraft({
    key: "key",
    storage: h.storage,
    etag: "original",
    initial: table,
    notify: () => {},
    read: async () => {
      assert.fail("Deletion must require a new session");
    },
    write: async () => ({ etag: "saved" }),
    erase: async () => {},
  });
  draft.edit({ ...table, rows: [["Edited", "", ""]] });
  await draft.save();
  await draft.delete();
  await assert.rejects(draft.revert(), /Reopen Saved Draft/);
  assert.equal(draft.blocked, true);
  draft.dispose();
});

for (const etag of [null, "base"]) {
  test(`returning to the untouched baseline cancels persistence (${etag})`, async () => {
    let writes = 0;
    const h = draftHarness(
      async () => {
        writes++;
        return { etag: "saved" };
      },
      { etag, initial: table },
    );
    h.draft.edit({ ...table, rows: [["Temporary", "", ""]] });
    assert.equal(h.draft.dirty, true);
    assert.equal(h.data.size, 1);
    h.draft.edit(table);
    assert.equal(h.draft.dirty, false);
    assert.equal(h.draft.changed, false);
    assert.equal(h.data.size, 0);
    h.tick();
    await h.draft.save();
    assert.equal(writes, 0);
    assert.equal(h.draft.etag, etag);
    h.draft.dispose();
  });
}
for (const status of [409, 502]) {
  test(`failed deletion (${status}) blocks autosave after task cleanup and preserves recovery`, async () => {
    let writes = 0;
    const h = draftHarness(
      async () => {
        writes++;
        return { etag: "saved" };
      },
      {
        initial: table,
        erase: async (etag) => {
          assert.equal(etag, "base");
          throw Object.assign(Error("delete failed"), { status });
        },
      },
    );
    const edited = { ...table, rows: [["Keep me", "", ""]] };
    h.draft.edit(edited);
    await assert.rejects(h.draft.delete(), /delete failed/);
    h.draft.pause(false);
    h.tick();
    assert.equal(writes, 0);
    assert.equal(h.draft.etag, "base");
    assert.equal(h.draft.blocked, true);
    assert.deepEqual(readRecovery(h.storage, "draft").table, edited);
    await assert.rejects(h.draft.save(), /reopen/);
    assert.equal(writes, 0);
    h.draft.dispose();
  });
}
test("returning to baseline while a write is pending still requires reconciliation", async () => {
  const gate = deferred();
  const h = draftHarness(
    async () => {
      await gate.promise;
      return { etag: "saved" };
    },
    { initial: table },
  );
  h.draft.edit({ ...table, rows: [["Pending", "", ""]] });
  const save = h.draft.save();
  h.draft.edit(table);
  h.draft.pause(true);
  assert.equal(h.draft.dirty, true);
  assert.equal(h.draft.changed, true);
  assert.deepEqual(readRecovery(h.storage, "draft").table, table);
  gate.resolve();
  await save;
  assert.equal(h.draft.dirty, true);
  assert.equal(h.draft.changed, true);
  h.draft.dispose();
});
test("matching the baseline preserves recovered work with unresolved older provenance", () => {
  const h = draftHarness(async () => ({ etag: "saved" }), { initial: table });
  h.draft.recover({ table, etag: "older" });
  h.draft.edit(table);
  assert.equal(h.draft.dirty, true);
  assert.equal(readRecovery(h.storage, "draft").etag, "older");
  h.draft.dispose();
});

test("returning to baseline after an uncertain write preserves reconciliation and recovery", async () => {
  const h = draftHarness(
    async () => {
      throw Error("outcome unknown");
    },
    { etag: null, initial: table },
  );
  h.draft.edit({ ...table, rows: [["Uncertain", "", ""]] });
  await assert.rejects(h.draft.save());
  h.draft.edit(table);
  assert.equal(h.draft.dirty, true);
  assert.equal(h.draft.changed, true);
  assert.deepEqual(readRecovery(h.storage, "draft").table, table);
  h.draft.dispose();
});
test("failed deletion restores recovery after an in-flight save has cleared it", async () => {
  const gate = deferred(),
    edited = { ...table, rows: [["Pending", "", ""]] };
  const h = draftHarness(
    async () => {
      await gate.promise;
      return { etag: "saved" };
    },
    {
      initial: table,
      erase: async (etag) => {
        assert.equal(etag, "saved");
        throw Error("delete failed");
      },
    },
  );
  h.draft.edit(edited);
  const save = h.draft.save(),
    deletion = h.draft.delete();
  gate.resolve();
  await save;
  await assert.rejects(deletion, /delete failed/);
  assert.deepEqual(readRecovery(h.storage, "draft").table, edited);
  assert.equal(h.draft.blocked, true);
  h.draft.dispose();
});
