import { test } from "node:test";
import assert from "node:assert/strict";

let instance = 0;
const names = () =>
  import(`../../../site/assets/players.js?names=${instance++}`);
const participant = (id) => ({ player_id: id });
const player = (id, name) => ({ id, name });

test("latest loaded roster resolves a full season without weekly requests", async () => {
  const n = await names();
  n.rememberPlayerNames([player("alice", "Latest Alice")], 18);
  await n.loadSeasonPlayerNames(
    [participant("alice")],
    Array.from({ length: 18 }, (_, i) => i + 1),
    () => assert.fail("unnecessary request"),
  );
  assert.equal(n.getPlayerName("alice"), "Latest Alice");
});

test("search is newest first and stops after finding historical players", async () => {
  const n = await names(),
    requests = [];
  n.rememberPlayerNames([player("alice", "Old Alice")], 1);
  await n.loadSeasonPlayerNames(
    ["alice", "retired"].map(participant),
    [1, 2, 3, 4],
    async (week) => {
      requests.push(week);
      return {
        players:
          week === 4
            ? [player("alice", "New Alice")]
            : [player("retired", "Retired Name")],
      };
    },
  );
  assert.deepEqual(requests, [4, 3]);
  assert.equal(n.getPlayerName("alice"), "New Alice");
  assert.equal(n.getPlayerName("retired"), "Retired Name");
  // An older weekly response arriving later cannot replace the current name.
  n.rememberPlayerNames([player("alice", "Late Old Alice")], 2);
  assert.equal(n.getPlayerName("alice"), "New Alice");
});

test("unavailable files continue searching and unknown players keep their fallback", async () => {
  const n = await names(),
    requests = [];
  await n.loadSeasonPlayerNames(
    ["historical", "unknown-player"].map(participant),
    [1, 2, 3],
    async (week) => {
      requests.push(week);
      if (week !== 1) throw new Error("Unavailable");
      return { players: [player("historical", "Historical Name")] };
    },
  );
  assert.deepEqual(requests, [3, 2, 1]);
  assert.equal(n.getPlayerName("historical"), "Historical Name");
  assert.equal(n.getPlayerName("unknown-player"), "Unknown Player");
});

test("weekly requests are reused for names and concurrent discovery, but refreshed by normal navigation", async () => {
  const { fetchWeek } = await import("../../../site/assets/data.js");
  const original = globalThis.fetch,
    requests = [];
  globalThis.fetch = async (url) => {
    requests.push(url);
    return { ok: true, json: async () => ({ players: [] }) };
  };
  try {
    const first = fetchWeek(2026, 12);
    await Promise.all([
      first,
      fetchWeek(2026, 12, { reuse: true }),
      fetchWeek(2026, 12, { reuse: true }),
    ]);
    assert.equal(requests.length, 1);
    await fetchWeek(2026, 12);
    assert.equal(requests.length, 2);
  } finally {
    globalThis.fetch = original;
  }
});

test("overlapping weekly responses cannot overwrite a newer authoritative name", async () => {
  const n = await names();
  let finishOld, finishNew;
  const old = new Promise((resolve) => {
    finishOld = resolve;
  });
  const current = new Promise((resolve) => {
    finishNew = resolve;
  });
  const rememberingOld = old.then((data) =>
    n.rememberPlayerNames(data.players, 1),
  );
  const resolving = n.loadSeasonPlayerNames(
    [participant("renamed")],
    [1, 2],
    () => current,
  );
  finishNew({ players: [player("renamed", "Current Name")] });
  await resolving;
  finishOld({ players: [player("renamed", "Previous Name")] });
  await rememberingOld;
  assert.equal(n.getPlayerName("renamed"), "Current Name");
});

test("failed name requests are evicted so subsequent discovery can retry", async () => {
  const { fetchWeek } = await import("../../../site/assets/data.js");
  const original = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    return { ok: requests > 1, json: async () => ({ players: [] }) };
  };
  try {
    await assert.rejects(fetchWeek(2026, 13, { reuse: true }), /not available/);
    await fetchWeek(2026, 13, { reuse: true });
    assert.equal(requests, 2);
  } finally {
    globalThis.fetch = original;
  }
});
