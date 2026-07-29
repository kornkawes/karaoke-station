import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApplication } from "../../server/app.js";
import {
  isLoopbackAddress,
  parseRequestAuthority,
  PartySessions,
  requireLoopback
} from "../../server/middleware/access.js";

const videoA = {
  videoId: "dQw4w9WgXcQ",
  title: "เพลงทดสอบ ก ไก่",
  channelTitle: "ช่องทดสอบ",
  thumbnailUrl: "https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg"
};
const videoB = {
  videoId: "abcdefghijk",
  title: "Second song",
  channelTitle: "Channel",
  thumbnailUrl: "https://i.ytimg.com/vi/abcdefghijk/mqdefault.jpg"
};

let dataDir;
let runtime;

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "karaoke-api-"));
  runtime = await createApplication({
    dataDir,
    env: { YOUTUBE_API_KEY: "very-secret-key" },
    distDir: path.join(dataDir, "missing-dist"),
    fetchImpl: vi.fn()
  });
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

function jsonMutation(method, url) {
  return request(runtime.app)[method](url).set("Content-Type", "application/json");
}

describe("security and config", () => {
  it("sends a YouTube-compatible referrer policy and CSP", async () => {
    const response = await request(runtime.app).get("/api/v1/health").expect(200);
    expect(response.headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
    expect(response.headers["content-security-policy"]).toContain("https://www.youtube.com");
    expect(response.headers["content-security-policy"]).not.toContain("upgrade-insecure-requests");
  });

  it("never returns the YouTube API key", async () => {
    const response = await request(runtime.app).get("/api/v1/config").expect(200);
    expect(response.body.data.youtube).toEqual({ configured: true, key: null });
    expect(JSON.stringify(response.body)).not.toContain("very-secret-key");
  });

  it("can save and clear the YouTube key without returning or logging it", async () => {
    const secret = "new-super-secret-youtube-key";
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const saved = await jsonMutation("put", "/api/v1/settings/youtube-key")
      .send({ youtubeApiKey: secret })
      .expect(200);
    expect(saved.body.data.youtube).toEqual({ configured: true, key: null });
    expect(JSON.stringify(saved.body)).not.toContain(secret);

    const cleared = await jsonMutation("put", "/api/v1/settings/youtube-key")
      .send({ youtubeApiKey: "" })
      .expect(200);
    expect(cleared.body.data.youtube).toEqual({ configured: true, key: null });
    expect(`${log.mock.calls.flat().join(" ")} ${error.mock.calls.flat().join(" ")}`)
      .not.toContain(secret);
    log.mockRestore();
    error.mockRestore();
  });

  it("rejects cross-origin mutations", async () => {
    await jsonMutation("post", "/api/v1/queue")
      .set("Origin", "https://evil.example")
      .send({ track: videoA })
      .expect(403);
  });

  it("recognizes loopback variants and rejects a LAN address", () => {
    expect(isLoopbackAddress("::1")).toBe(true);
    expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("192.168.1.4")).toBe(false);
    let received;
    requireLoopback(
      { socket: { remoteAddress: "192.168.1.4" } },
      {},
      (error) => { received = error; }
    );
    expect(received).toMatchObject({ status: 403, code: "host_only" });
  });

  it.each([
    ["localhost:4173", "localhost"],
    ["LOCALHOST:4173", "localhost"],
    ["127.0.0.1:4173", "127.0.0.1"],
    ["[::1]:4173", "::1"]
  ])("accepts exact loopback authority %s", (host, hostname) => {
    expect(parseRequestAuthority({
      headers: { host },
      socket: { localPort: 4173 }
    }, { loopbackOnly: true })).toMatchObject({ hostname, port: 4173 });
  });

  it.each([
    "evil.example:4173",
    "127.0.0.1.evil:4173",
    "localhost.:4173",
    "user@localhost:4173",
    "localhost:4173/path",
    "localhost:abc",
    "localhost:4174",
    "localhost"
  ])("rejects unsafe or mismatched loopback authority %s", (host) => {
    expect(parseRequestAuthority({
      headers: { host },
      socket: { localPort: 4173 }
    }, { loopbackOnly: true })).toBeNull();
  });

  it("rejects an evil Host on every route of the main listener", async () => {
    const server = createServer(runtime.app);
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    runtime.app.locals.hostPort = address.port;
    try {
      await request(server)
        .get("/api/v1/party/status")
        .set("Host", `evil.example:${address.port}`)
        .expect(403);
      await request(server)
        .get("/api/v1/party/status")
        .set("Host", `127.0.0.1:${address.port}`)
        .expect(200);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("rejects evil Host values on host-only reads and mutations", async () => {
    await request(runtime.app)
      .get("/api/v1/state")
      .set("Host", "evil.example:4173")
      .expect(403);
    await jsonMutation("post", "/api/v1/party/session/start")
      .set("Host", "evil.example:4173")
      .send({})
      .expect(403);
  });
});

describe("queue and library API", () => {
  it("persists add, reorder, advance, history and validation failures", async () => {
    const first = await jsonMutation("post", "/api/v1/queue")
      .send({ track: videoA })
      .expect(201);
    expect(first.body.data.queue.current.videoId).toBe(videoA.videoId);

    const second = await jsonMutation("post", "/api/v1/queue")
      .send({ track: videoB })
      .expect(201);
    const videoC = { ...videoB, videoId: "lmnopqrstuv", title: "Third" };
    await jsonMutation("post", "/api/v1/queue").send({ track: videoC }).expect(201);

    await jsonMutation("patch", "/api/v1/queue/reorder")
      .send({ itemId: second.body.data.item.id, toIndex: 1 })
      .expect(200);
    const advanced = await jsonMutation("post", "/api/v1/queue/advance").send({}).expect(200);
    expect(advanced.body.data.current.videoId).toBe(videoC.videoId);

    const history = await request(runtime.app).get("/api/v1/history").expect(200);
    expect(history.body.data.items[0]).toMatchObject({
      videoId: videoA.videoId,
      status: "completed"
    });

    await jsonMutation("post", "/api/v1/queue")
      .send({ track: { ...videoA, videoId: "bad" } })
      .expect(400);
  });

  it("supports favorites and manual Thai lyrics", async () => {
    await jsonMutation("post", "/api/v1/favorites").send(videoA).expect(201);
    const favorite = await request(runtime.app).get("/api/v1/favorites").expect(200);
    expect(favorite.body.data.items).toHaveLength(1);

    const content = "รักเธอที่สุด\nแม้คืนจะยาวนาน";
    await jsonMutation("put", `/api/v1/lyrics/${videoA.videoId}`)
      .send({ kind: "plain", content, source: "manual" })
      .expect(200);
    const lyric = await request(runtime.app).get(`/api/v1/lyrics/${videoA.videoId}`).expect(200);
    expect(lyric.body.data.item.content).toBe(content);
  });
});

describe("Party Mode", () => {
  it("waits for the LAN listener before returning the first usable QR URL", async () => {
    const ensurePartyListener = vi.fn(async () => {
      await Promise.resolve();
      runtime.app.locals.partyBaseUrls = ["http://192.168.1.25:4174"];
    });
    runtime.app.locals.ensurePartyListener = ensurePartyListener;

    const response = await jsonMutation("post", "/api/v1/party/session/start")
      .send({})
      .expect(200);

    expect(ensurePartyListener).toHaveBeenCalledOnce();
    expect(response.body.data.urls).toEqual([
      expect.stringMatching(/^http:\/\/192\.168\.1\.25:4174\/party#join=[A-Za-z0-9_-]+$/)
    ]);
    expect(response.body.data.urls[0]).not.toContain("127.0.0.1");
  });

  it("returns a listener failure and rolls back first-time Party enablement", async () => {
    runtime.app.locals.ensurePartyListener = vi.fn().mockRejectedValue(
      Object.assign(new Error("bind failed"), { code: "EADDRINUSE" })
    );

    const response = await jsonMutation("post", "/api/v1/party/session/start")
      .send({})
      .expect(503);

    expect(response.body.error.code).toBe("party_listener_unavailable");
    expect(runtime.repository.snapshot().settings.partyEnabled).toBe(false);
    expect(JSON.stringify(response.body)).not.toContain("bind failed");
  });

  it("starts a fresh fragment-based launch session and revokes old credentials", async () => {
    const first = await jsonMutation("post", "/api/v1/party/session/start")
      .send({})
      .expect(200);
    expect(first.body.data).toMatchObject({
      enabled: true,
      sessionId: expect.any(String),
      pin: expect.stringMatching(/^\d{6}$/),
      joinPath: expect.stringMatching(/^\/party#join=/)
    });
    expect(first.body.data.joinPath).not.toContain("?code=");
    const firstJoinToken = decodeURIComponent(first.body.data.joinPath.split("#join=")[1]);
    const joined = await jsonMutation("post", "/api/v1/party/join")
      .send({ joinToken: firstJoinToken, displayName: "แขกหนึ่ง" })
      .expect(201);

    const second = await jsonMutation("post", "/api/v1/party/session/start")
      .send({})
      .expect(200);
    expect(second.body.data.sessionId).not.toBe(first.body.data.sessionId);
    expect(second.body.data.pin).not.toBe(first.body.data.pin);
    await jsonMutation("post", "/api/v1/party/join")
      .send({ joinToken: firstJoinToken, displayName: "แขกเก่า" })
      .expect(401);
    await jsonMutation("post", "/api/v1/party/queue")
      .set("Authorization", `Bearer ${joined.body.data.token}`)
      .send({ track: videoA })
      .expect(401);

    const publicStatus = await request(runtime.app).get("/api/v1/party/status").expect(200);
    expect(JSON.stringify(publicStatus.body)).not.toContain(second.body.data.pin);
    expect(JSON.stringify(publicStatus.body)).not.toContain("#join=");
  });

  it("models process restart by rejecting tokens in a new in-memory session manager", async () => {
    await jsonMutation("post", "/api/v1/party/session/start").send({}).expect(200);
    const party = await request(runtime.app).get("/api/v1/party").expect(200);
    const joined = await jsonMutation("post", "/api/v1/party/join")
      .send({ pin: party.body.data.pin, displayName: "แขกก่อนรีสตาร์ต" })
      .expect(201);

    const restartedSessions = new PartySessions({ repository: runtime.repository });
    expect(() => restartedSessions.authenticate(joined.body.data.token)).toThrow(
      expect.objectContaining({ code: "party_session_expired" })
    );
  });

  it("caps in-memory controller sessions", async () => {
    await jsonMutation("post", "/api/v1/party/session/start").send({}).expect(200);
    const limitedSessions = new PartySessions({
      repository: runtime.repository,
      maxSessions: 1
    });
    const pin = runtime.repository.getPartyPin();
    limitedSessions.join({ pin, displayName: "คนแรก" });
    expect(() => limitedSessions.join({ pin, displayName: "คนที่สอง" })).toThrow(
      expect.objectContaining({ status: 429, code: "party_session_limit" })
    );
  });

  it("rotates an expired PIN on Off→On but not when already enabled", async () => {
    await runtime.repository.mutateSecrets((draft) => {
      draft.partyPin = "123456";
      draft.partyPinExpiresAt = new Date(0).toISOString();
    });

    await jsonMutation("patch", "/api/v1/settings")
      .send({ partyEnabled: true })
      .expect(200);
    const firstParty = await request(runtime.app).get("/api/v1/party").expect(200);
    expect(firstParty.body.data.pin).toMatch(/^\d{6}$/);
    expect(firstParty.body.data.pin).not.toBe("123456");
    expect(Date.parse(firstParty.body.data.pinExpiresAt)).toBeGreaterThan(Date.now());
    await jsonMutation("post", "/api/v1/party/join")
      .send({ pin: firstParty.body.data.pin, displayName: "แขกหนึ่ง" })
      .expect(201);

    await jsonMutation("patch", "/api/v1/settings")
      .send({ partyEnabled: true })
      .expect(200);
    const secondParty = await request(runtime.app).get("/api/v1/party").expect(200);
    expect(secondParty.body.data.pin).toBe(firstParty.body.data.pin);
    expect(secondParty.body.data.pinExpiresAt).toBe(firstParty.body.data.pinExpiresAt);
  });

  it("requires an active PIN session and limits guests to search/enqueue routes", async () => {
    await jsonMutation("post", "/api/v1/party/join")
      .send({ pin: "123456", displayName: "นัท" })
      .expect(401);

    await jsonMutation("patch", "/api/v1/settings")
      .send({ partyEnabled: true })
      .expect(200);
    const party = await request(runtime.app).get("/api/v1/party").expect(200);
    const join = await jsonMutation("post", "/api/v1/party/join")
      .send({ pin: party.body.data.pin, displayName: "นัท" })
      .expect(201);
    const token = join.body.data.token;

    await jsonMutation("post", "/api/v1/party/queue")
      .set("Authorization", `Bearer ${token}`)
      .send({ track: videoA })
      .expect(201);
    const status = await request(runtime.app).get("/api/v1/party/status").expect(200);
    expect(status.body.data.current).toMatchObject({
      videoId: videoA.videoId,
      requestedBy: "นัท"
    });

    await jsonMutation("post", "/api/v1/party/rotate").send({}).expect(200);
    await jsonMutation("post", "/api/v1/party/queue")
      .set("Authorization", `Bearer ${token}`)
      .send({ track: videoB })
      .expect(401);
  });

  it("rate-limits repeated PIN guesses per IP", async () => {
    await jsonMutation("patch", "/api/v1/settings")
      .send({ partyEnabled: true })
      .expect(200);
    const party = await request(runtime.app).get("/api/v1/party").expect(200);
    const wrongPin = String((Number(party.body.data.pin) + 1) % 1_000_000).padStart(6, "0");

    for (let attempt = 0; attempt < 10; attempt += 1) {
      await jsonMutation("post", "/api/v1/party/join")
        .send({ pin: wrongPin, displayName: "ผู้ลองรหัส" })
        .expect(401);
    }
    const limited = await jsonMutation("post", "/api/v1/party/join")
      .send({ pin: party.body.data.pin, displayName: "แขกจริง" })
      .expect(429);
    expect(limited.body.error.code).toBe("party_join_rate_limited");
  });

  it("serializes concurrent enqueue requests from three authenticated guests", async () => {
    await jsonMutation("patch", "/api/v1/settings")
      .send({ partyEnabled: true })
      .expect(200);
    const party = await request(runtime.app).get("/api/v1/party").expect(200);
    const guests = await Promise.all(["แขกหนึ่ง", "แขกสอง", "แขกสาม"].map(async (displayName) => {
      const joined = await jsonMutation("post", "/api/v1/party/join")
        .send({ pin: party.body.data.pin, displayName })
        .expect(201);
      return joined.body.data.token;
    }));
    const tracks = [
      videoA,
      videoB,
      { ...videoB, videoId: "lmnopqrstuv", title: "Third song" }
    ];

    await Promise.all(guests.map((token, index) => (
      jsonMutation("post", "/api/v1/party/queue")
        .set("Authorization", `Bearer ${token}`)
        .send({ track: tracks[index] })
        .expect(201)
    )));

    const state = await request(runtime.app).get("/api/v1/queue").expect(200);
    const allTracks = [state.body.data.current, ...state.body.data.items];
    expect(allTracks).toHaveLength(3);
    expect(new Set(allTracks.map((track) => track.videoId))).toEqual(
      new Set(tracks.map((track) => track.videoId))
    );
    expect(new Set(allTracks.map((track) => track.requestedBy))).toEqual(
      new Set(["แขกหนึ่ง", "แขกสอง", "แขกสาม"])
    );
  });

  it("grants every controller remove, reorder, skip and play-now with revision checks", async () => {
    const actions = [];
    runtime.events.on("party:action", (action) => actions.push(action));
    await jsonMutation("post", "/api/v1/party/session/start").send({}).expect(200);
    const party = await request(runtime.app).get("/api/v1/party").expect(200);
    const joined = await jsonMutation("post", "/api/v1/party/join")
      .send({ pin: party.body.data.pin, displayName: "ดีเจมือถือ" })
      .expect(201);
    const auth = { Authorization: `Bearer ${joined.body.data.token}` };

    const first = await jsonMutation("post", "/api/v1/party/queue")
      .set(auth)
      .send({ track: videoA })
      .expect(201);
    const second = await jsonMutation("post", "/api/v1/party/queue")
      .set(auth)
      .send({ track: videoB })
      .expect(201);
    const videoC = { ...videoB, videoId: "lmnopqrstuv", title: "Third song" };
    const third = await jsonMutation("post", "/api/v1/party/queue")
      .set(auth)
      .send({ track: videoC })
      .expect(201);

    const reordered = await jsonMutation("patch", "/api/v1/party/queue/reorder")
      .set(auth)
      .send({
        itemId: third.body.data.item.id,
        toIndex: 0,
        revision: third.body.data.revision
      })
      .expect(200);
    const played = await jsonMutation("post", "/api/v1/party/queue/play-now")
      .set(auth)
      .send({
        itemId: second.body.data.item.id,
        revision: reordered.body.data.revision
      })
      .expect(200);
    expect(played.body.data.current.videoId).toBe(videoB.videoId);

    const skipped = await jsonMutation("post", "/api/v1/party/queue/skip")
      .set(auth)
      .send({ revision: played.body.data.revision })
      .expect(200);
    expect(skipped.body.data.current.videoId).toBe(videoC.videoId);

    await jsonMutation("delete", `/api/v1/party/queue/${skipped.body.data.current.id}`)
      .set(auth)
      .send({ revision: skipped.body.data.revision })
      .expect(200);
    expect(actions.map((action) => action.action)).toEqual([
      "add", "add", "add", "reorder", "play_now", "skip", "remove"
    ]);
    for (const action of actions) {
      expect(action).toMatchObject({
        actor: "ดีเจมือถือ",
        revision: expect.any(Number),
        timestamp: expect.any(String)
      });
      expect(JSON.stringify(action)).not.toContain("very-secret-key");
    }
    expect(first.body.data.queue.current.videoId).toBe(videoA.videoId);
  });

  it("serializes concurrent stale reorders so exactly one succeeds", async () => {
    await jsonMutation("post", "/api/v1/party/session/start").send({}).expect(200);
    const party = await request(runtime.app).get("/api/v1/party").expect(200);
    const joined = await jsonMutation("post", "/api/v1/party/join")
      .send({ pin: party.body.data.pin, displayName: "ผู้จัดคิว" })
      .expect(201);
    const auth = { Authorization: `Bearer ${joined.body.data.token}` };
    await jsonMutation("post", "/api/v1/party/queue").set(auth).send({ track: videoA }).expect(201);
    const second = await jsonMutation("post", "/api/v1/party/queue")
      .set(auth).send({ track: videoB }).expect(201);
    const third = await jsonMutation("post", "/api/v1/party/queue")
      .set(auth)
      .send({ track: { ...videoB, videoId: "lmnopqrstuv", title: "Third" } })
      .expect(201);
    const revision = third.body.data.revision;

    const [moveA, moveB] = await Promise.all([
      jsonMutation("patch", "/api/v1/party/queue/reorder")
        .set(auth)
        .send({ itemId: second.body.data.item.id, toIndex: 1, revision }),
      jsonMutation("patch", "/api/v1/party/queue/reorder")
        .set(auth)
        .send({ itemId: third.body.data.item.id, toIndex: 0, revision })
    ]);
    expect([moveA.status, moveB.status].sort()).toEqual([200, 409]);
    const conflict = [moveA, moveB].find((response) => response.status === 409);
    expect(conflict.body.error).toMatchObject({
      code: "revision_conflict",
      details: { expectedRevision: revision + 1 }
    });

    await jsonMutation("patch", "/api/v1/party/queue/reorder")
      .set(auth)
      .send({
        itemId: (await request(runtime.app).get("/api/v1/queue")).body.data.current.id,
        toIndex: 0,
        revision: revision + 1
      })
      .expect(409);
  });

  it("exposes and reorders the full waiting queue beyond the first ten items", async () => {
    const tracks = Array.from({ length: 13 }, (_, index) => ({
      ...videoA,
      videoId: String(index).padStart(11, "0"),
      title: `Queue song ${index + 1}`
    }));
    for (const track of tracks) {
      await jsonMutation("post", "/api/v1/queue").send({ track }).expect(201);
    }
    await jsonMutation("post", "/api/v1/party/session/start").send({}).expect(200);
    const party = await request(runtime.app).get("/api/v1/party").expect(200);
    const joined = await jsonMutation("post", "/api/v1/party/join")
      .send({ pin: party.body.data.pin, displayName: "ผู้จัดท้ายคิว" })
      .expect(201);
    const status = await request(runtime.app).get("/api/v1/party/status").expect(200);

    expect(status.body.data.next).toHaveLength(12);
    expect(status.body.data.next.at(-1).title).toBe("Queue song 13");
    const moved = await jsonMutation("patch", "/api/v1/party/queue/reorder")
      .set("Authorization", `Bearer ${joined.body.data.token}`)
      .send({
        itemId: status.body.data.next.at(-1).id,
        toIndex: 0,
        revision: status.body.data.revision
      })
      .expect(200);
    expect(moved.body.data.queue.items[0].title).toBe("Queue song 13");
    expect(moved.body.data.queue.items).toHaveLength(12);
  });

  it("serves suggestions from local state without calling YouTube", async () => {
    await jsonMutation("post", "/api/v1/queue").send({ track: videoA }).expect(201);
    const response = await request(runtime.app)
      .get("/api/v1/suggestions?q=เพลง&limit=8")
      .expect(200);
    expect(response.body.data.suggestions).toEqual([
      { text: "เพลงทดสอบ ก ไก่", source: "queue" }
    ]);
    expect(runtime.services.youtube.fetchImpl).not.toHaveBeenCalled();
  });
});
