import path from "node:path";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHostedApplication, isAllowedOrigin, parseAllowedOrigins } from "../../server/hosted/app.js";
import { MemoryRoomStore } from "../../server/hosted/rooms.js";

const ORIGIN = "https://karaoke.example";

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

let runtime;
let clock;

beforeEach(async () => {
  clock = { value: Date.UTC(2026, 6, 29, 12, 0, 0) };
  runtime = await createHostedApplication({
    env: {
      YOUTUBE_API_KEY: "very-secret-key",
      ALLOWED_ORIGINS: ORIGIN
    },
    distDir: path.join(process.cwd(), "missing-dist"),
    fetchImpl: vi.fn(),
    store: new MemoryRoomStore({ now: () => clock.value }),
    now: () => clock.value
  });
});

function api(method, url) {
  return request(runtime.app)[method](url).set("Content-Type", "application/json");
}

async function createRoom() {
  const response = await api("post", "/api/v1/rooms").send({}).expect(201);
  return response.body.data;
}

async function joinRoom(room, displayName = "มือถือ") {
  const response = await api("post", `/api/v1/rooms/${room.roomId}/join`)
    .send({ joinToken: room.joinToken, displayName })
    .expect(201);
  return response.body.data;
}

function addTrack(room, token, track = videoA) {
  return api("post", `/api/v1/rooms/${room.roomId}/queue`)
    .set("Authorization", `Bearer ${token}`)
    .send({ track });
}

describe("room lifecycle", () => {
  it("creates a room with distinct high-entropy tokens and a join path", async () => {
    const room = await createRoom();
    expect(room.roomId).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
    // 256-bit tokens base64url-encode to 43 characters.
    expect(room.hostToken).toHaveLength(43);
    expect(room.joinToken).toHaveLength(43);
    expect(room.hostToken).not.toBe(room.joinToken);
    expect(room.joinPath).toBe(
      `/party#room=${room.roomId}&join=${encodeURIComponent(room.joinToken)}`
    );
  });

  it("puts the join token in the fragment only, never the query string", async () => {
    const room = await createRoom();
    const [pathPart] = room.joinPath.split("#");
    expect(pathPart).toBe("/party");
    expect(pathPart).not.toContain(room.joinToken);
  });

  it("returns 404 for an unknown room instead of leaking existence details", async () => {
    const response = await api("get", "/api/v1/rooms/AAAAAAAA")
      .set("Authorization", "Bearer whatever-token-value-padding-1234567890")
      .expect(404);
    expect(response.body.error.code).toBe("room_not_found");
  });
});

describe("cross-room isolation", () => {
  it("rejects a controller of room A reading room B", async () => {
    const roomA = await createRoom();
    const roomB = await createRoom();
    const controllerA = await joinRoom(roomA);

    const response = await api("get", `/api/v1/rooms/${roomB.roomId}/queue`)
      .set("Authorization", `Bearer ${controllerA.token}`)
      .expect(401);
    // Room B has no such controller, so it reads as an unknown/expired session.
    expect(response.body.error.code).toBe("controller_session_expired");
  });

  it("rejects a controller of room A mutating room B", async () => {
    const roomA = await createRoom();
    const roomB = await createRoom();
    const controllerA = await joinRoom(roomA);

    await addTrack(roomB, controllerA.token).expect(401);

    const hostB = await api("get", `/api/v1/rooms/${roomB.roomId}`)
      .set("Authorization", `Bearer ${roomB.hostToken}`)
      .expect(200);
    expect(hostB.body.data.queue).toHaveLength(0);
    expect(hostB.body.data.current).toBeNull();
  });

  it("rejects a host token of room A against room B", async () => {
    const roomA = await createRoom();
    const roomB = await createRoom();

    const response = await api("get", `/api/v1/rooms/${roomB.roomId}`)
      .set("Authorization", `Bearer ${roomA.hostToken}`)
      .expect(403);
    expect(response.body.error.code).toBe("host_token_invalid");
  });

  it("scopes a join token to its own room", async () => {
    const roomA = await createRoom();
    const roomB = await createRoom();

    const response = await api("post", `/api/v1/rooms/${roomB.roomId}/join`)
      .send({ joinToken: roomA.joinToken, displayName: "ผู้บุกรุก" })
      .expect(401);
    expect(response.body.error.code).toBe("join_token_invalid");
  });
});

describe("role separation", () => {
  it("does not let a controller token act as host", async () => {
    const room = await createRoom();
    const controller = await joinRoom(room);

    const response = await api("post", `/api/v1/rooms/${room.roomId}/rotate`)
      .set("Authorization", `Bearer ${controller.token}`)
      .send({})
      .expect(403);
    expect(response.body.error.code).toBe("host_token_invalid");
  });

  it("does not let a host token be used as a controller session", async () => {
    const room = await createRoom();
    // The host token is not in room.controllers, so controller-only auth must fail.
    const store = runtime.store.require(room.roomId);
    expect(store.controllers.has(room.hostToken)).toBe(false);
  });

  it("does not let a controller close the room", async () => {
    const room = await createRoom();
    const controller = await joinRoom(room);

    await api("delete", `/api/v1/rooms/${room.roomId}`)
      .set("Authorization", `Bearer ${controller.token}`)
      .send({})
      .expect(403);
    expect(runtime.store.get(room.roomId)).toBeDefined();
  });

  it("does not let a controller change room settings", async () => {
    const room = await createRoom();
    const controller = await joinRoom(room);

    await api("patch", `/api/v1/rooms/${room.roomId}/settings`)
      .set("Authorization", `Bearer ${controller.token}`)
      .send({ stationName: "ยึดห้อง" })
      .expect(403);
  });

  it("does not let a controller advance playback", async () => {
    const room = await createRoom();
    const controller = await joinRoom(room);

    await api("post", `/api/v1/rooms/${room.roomId}/queue/advance`)
      .set("Authorization", `Bearer ${controller.token}`)
      .send({})
      .expect(403);
  });

  it("ignores playNow from a controller so it cannot preempt the current song", async () => {
    const room = await createRoom();
    const controller = await joinRoom(room);

    await addTrack(room, room.hostToken, videoA).expect(201);
    await api("post", `/api/v1/rooms/${room.roomId}/queue`)
      .set("Authorization", `Bearer ${controller.token}`)
      .send({ track: videoB, playNow: true })
      .expect(201);

    const view = await api("get", `/api/v1/rooms/${room.roomId}/queue`)
      .set("Authorization", `Bearer ${room.hostToken}`)
      .expect(200);
    expect(view.body.data.current.videoId).toBe(videoA.videoId);
  });
});

describe("token rejection", () => {
  it("rejects a guessed token", async () => {
    const room = await createRoom();
    const response = await api("get", `/api/v1/rooms/${room.roomId}`)
      .set("Authorization", `Bearer ${"a".repeat(43)}`)
      .expect(403);
    expect(response.body.error.code).toBe("host_token_invalid");
  });

  it("rejects a missing token", async () => {
    const room = await createRoom();
    await api("get", `/api/v1/rooms/${room.roomId}`).expect(401);
  });

  it("rejects an expired controller token", async () => {
    const room = await createRoom();
    const controller = await joinRoom(room);

    clock.value += 13 * 60 * 60 * 1_000;

    const response = await api("get", `/api/v1/rooms/${room.roomId}/queue`)
      .set("Authorization", `Bearer ${controller.token}`)
      .expect(404); // the room itself has also aged out by then
    expect(response.body.error.code).toBe("room_not_found");
  });

  it("revokes controller tokens when the room rotates", async () => {
    const room = await createRoom();
    const controller = await joinRoom(room);
    await addTrack(room, controller.token).expect(201);

    const rotated = await api("post", `/api/v1/rooms/${room.roomId}/rotate`)
      .set("Authorization", `Bearer ${room.hostToken}`)
      .send({})
      .expect(200);
    expect(rotated.body.data.hostToken).not.toBe(room.hostToken);
    expect(rotated.body.data.joinToken).not.toBe(room.joinToken);

    await api("get", `/api/v1/rooms/${room.roomId}/queue`)
      .set("Authorization", `Bearer ${controller.token}`)
      .expect(401);
  });

  it("revokes the old host token when the room rotates", async () => {
    const room = await createRoom();
    await api("post", `/api/v1/rooms/${room.roomId}/rotate`)
      .set("Authorization", `Bearer ${room.hostToken}`)
      .send({})
      .expect(200);

    await api("get", `/api/v1/rooms/${room.roomId}`)
      .set("Authorization", `Bearer ${room.hostToken}`)
      .expect(403);
  });

  it("rejects every token after the room is closed", async () => {
    const room = await createRoom();
    const controller = await joinRoom(room);

    await api("delete", `/api/v1/rooms/${room.roomId}`)
      .set("Authorization", `Bearer ${room.hostToken}`)
      .send({})
      .expect(200);

    await api("get", `/api/v1/rooms/${room.roomId}`)
      .set("Authorization", `Bearer ${room.hostToken}`)
      .expect(404);
    await api("get", `/api/v1/rooms/${room.roomId}/queue`)
      .set("Authorization", `Bearer ${controller.token}`)
      .expect(404);
  });
});

describe("room TTL", () => {
  it("expires an idle room and reports it as missing", async () => {
    const room = await createRoom();
    clock.value += 11 * 60 * 60 * 1_000;

    await api("get", `/api/v1/rooms/${room.roomId}`)
      .set("Authorization", `Bearer ${room.hostToken}`)
      .expect(404);
  });

  it("does not sweep a room that is still active", async () => {
    const room = await createRoom();

    // Stay active with a request every 6 hours across a 24-hour window.
    for (let step = 0; step < 4; step += 1) {
      clock.value += 6 * 60 * 60 * 1_000;
      await api("get", `/api/v1/rooms/${room.roomId}`)
        .set("Authorization", `Bearer ${room.hostToken}`)
        .expect(200);
      expect(runtime.store.sweep()).toBe(0);
    }

    expect(runtime.store.get(room.roomId)).toBeDefined();
  });

  it("sweeps only the expired room and leaves active rooms alone", async () => {
    const stale = await createRoom();
    clock.value += 9 * 60 * 60 * 1_000;
    const fresh = await createRoom();
    clock.value += 2 * 60 * 60 * 1_000;

    expect(runtime.store.sweep()).toBe(1);
    expect(runtime.store.get(stale.roomId)).toBeUndefined();
    expect(runtime.store.get(fresh.roomId)).toBeDefined();
  });
});

describe("queue semantics", () => {
  it("keeps every controller in sync on one shared queue", async () => {
    const room = await createRoom();
    const phoneA = await joinRoom(room, "โทรศัพท์ A");
    const phoneB = await joinRoom(room, "โทรศัพท์ B");

    await addTrack(room, phoneA.token, videoA).expect(201);
    await addTrack(room, phoneB.token, videoB).expect(201);

    const viewA = await api("get", `/api/v1/rooms/${room.roomId}/queue`)
      .set("Authorization", `Bearer ${phoneA.token}`)
      .expect(200);
    const viewB = await api("get", `/api/v1/rooms/${room.roomId}/queue`)
      .set("Authorization", `Bearer ${phoneB.token}`)
      .expect(200);

    expect(viewA.body.data).toEqual(viewB.body.data);
    expect(viewA.body.data.current.videoId).toBe(videoA.videoId);
    expect(viewA.body.data.queue).toHaveLength(1);
  });

  it("returns 409 with the expected revision on a stale reorder", async () => {
    const room = await createRoom();
    const controller = await joinRoom(room);
    await addTrack(room, room.hostToken, videoA).expect(201);
    const added = await addTrack(room, room.hostToken, videoB).expect(201);
    const itemId = added.body.data.item.id;
    const staleRevision = added.body.data.revision - 1;

    const response = await api("patch", `/api/v1/rooms/${room.roomId}/queue/reorder`)
      .set("Authorization", `Bearer ${controller.token}`)
      .send({ itemId, toIndex: 0, revision: staleRevision })
      .expect(409);
    expect(response.body.error.code).toBe("revision_conflict");
    expect(response.body.error.details.expectedRevision).toBe(added.body.data.revision);
  });

  it("serializes concurrent play-now so only one stale request wins", async () => {
    const room = await createRoom();
    await addTrack(room, room.hostToken, videoA).expect(201);
    const second = await addTrack(room, room.hostToken, videoB).expect(201);
    const revision = second.body.data.revision;
    const itemId = second.body.data.item.id;

    const [first, duplicate] = await Promise.all([
      api("post", `/api/v1/rooms/${room.roomId}/queue/play-now`)
        .set("Authorization", `Bearer ${room.hostToken}`)
        .send({ itemId, revision }),
      api("post", `/api/v1/rooms/${room.roomId}/queue/play-now`)
        .set("Authorization", `Bearer ${room.hostToken}`)
        .send({ itemId, revision })
    ]);

    const statuses = [first.status, duplicate.status].sort();
    expect(statuses).toEqual([200, 409]);
  });

  it("advances a song exactly once even if the display retries with a stale revision", async () => {
    const room = await createRoom();
    await addTrack(room, room.hostToken, videoA).expect(201);
    const second = await addTrack(room, room.hostToken, videoB).expect(201);
    const revision = second.body.data.revision;

    await api("post", `/api/v1/rooms/${room.roomId}/queue/advance`)
      .set("Authorization", `Bearer ${room.hostToken}`)
      .send({ revision })
      .expect(200);

    // A duplicate "video ended" event carrying the same revision must not skip videoB.
    await api("post", `/api/v1/rooms/${room.roomId}/queue/advance`)
      .set("Authorization", `Bearer ${room.hostToken}`)
      .send({ revision })
      .expect(409);

    const view = await api("get", `/api/v1/rooms/${room.roomId}/queue`)
      .set("Authorization", `Bearer ${room.hostToken}`)
      .expect(200);
    expect(view.body.data.current.videoId).toBe(videoB.videoId);
  });
});

describe("secret non-disclosure", () => {
  it("never returns the API key from any room route", async () => {
    const room = await createRoom();
    const controller = await joinRoom(room);

    const responses = await Promise.all([
      api("get", "/api/v1/health"),
      api("get", `/api/v1/rooms/${room.roomId}`).set("Authorization", `Bearer ${room.hostToken}`),
      api("get", `/api/v1/rooms/${room.roomId}/queue`).set("Authorization", `Bearer ${controller.token}`)
    ]);

    for (const response of responses) {
      expect(JSON.stringify(response.body)).not.toContain("very-secret-key");
      expect(JSON.stringify(response.headers)).not.toContain("very-secret-key");
    }
  });

  it("reports a generic setup error when the key is missing", async () => {
    const unconfigured = await createHostedApplication({
      env: { ALLOWED_ORIGINS: ORIGIN },
      distDir: path.join(process.cwd(), "missing-dist"),
      fetchImpl: vi.fn(),
      store: new MemoryRoomStore({ now: () => clock.value }),
      now: () => clock.value
    });
    const created = await request(unconfigured.app)
      .post("/api/v1/rooms")
      .set("Content-Type", "application/json")
      .send({})
      .expect(201);
    const room = created.body.data;
    expect(room.searchConfigured).toBe(false);

    const response = await request(unconfigured.app)
      .get(`/api/v1/rooms/${room.roomId}/search?q=test`)
      .set("Authorization", `Bearer ${room.hostToken}`)
      .expect(503);
    expect(response.body.error.code).toBe("search_unavailable");
    expect(JSON.stringify(response.body)).not.toMatch(/env|YOUTUBE_API_KEY|process/i);
  });
});

describe("transport hardening", () => {
  it("marks API responses no-store", async () => {
    const room = await createRoom();
    const response = await api("get", `/api/v1/rooms/${room.roomId}`)
      .set("Authorization", `Bearer ${room.hostToken}`)
      .expect(200);
    expect(response.headers["cache-control"]).toBe("no-store, max-age=0");
    expect(response.headers["pragma"]).toBe("no-cache");
  });

  it("marks the join response no-store so the bearer is not cached", async () => {
    const room = await createRoom();
    const response = await api("post", `/api/v1/rooms/${room.roomId}/join`)
      .send({ joinToken: room.joinToken, displayName: "มือถือ" })
      .expect(201);
    expect(response.headers["cache-control"]).toBe("no-store, max-age=0");
  });

  it("rejects a request from a disallowed Origin", async () => {
    const room = await createRoom();
    const response = await api("get", `/api/v1/rooms/${room.roomId}`)
      .set("Origin", "https://evil.example")
      .set("Authorization", `Bearer ${room.hostToken}`)
      .expect(403);
    expect(response.body.error.code).toBe("origin_not_allowed");
  });

  it("never emits an allow-origin header with credentials", async () => {
    const room = await createRoom();
    const response = await api("get", `/api/v1/rooms/${room.roomId}`)
      .set("Origin", ORIGIN)
      .set("Authorization", `Bearer ${room.hostToken}`)
      .expect(200);
    expect(response.headers["access-control-allow-credentials"]).toBeUndefined();
    expect(response.headers["access-control-allow-origin"]).not.toBe("*");
  });

  it("sends HSTS and denies framing", async () => {
    const response = await api("get", "/api/v1/health").expect(200);
    expect(response.headers["strict-transport-security"]).toContain("max-age=15552000");
    expect(response.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(response.headers["content-security-policy"]).toContain("upgrade-insecure-requests");
  });

  it("requires JSON content type for mutations", async () => {
    const room = await createRoom();
    await request(runtime.app)
      .post(`/api/v1/rooms/${room.roomId}/queue`)
      .set("Authorization", `Bearer ${room.hostToken}`)
      .set("Content-Type", "text/plain")
      .send("track=1")
      .expect(415);
  });

  it("rejects an oversized JSON body", async () => {
    const room = await createRoom();
    await api("post", `/api/v1/rooms/${room.roomId}/queue`)
      .set("Authorization", `Bearer ${room.hostToken}`)
      .send({ track: { ...videoA, title: "x".repeat(80_000) } })
      .expect(413);
  });

  it("does not trust proxy headers for the client address", () => {
    expect(runtime.app.get("trust proxy")).toBe(false);
  });
});

describe("origin allowlist parsing", () => {
  it("normalizes configured origins and drops invalid entries", () => {
    expect(parseAllowedOrigins("https://a.example, not-a-url ,https://B.example:8443/path"))
      .toEqual(["https://a.example", "https://b.example:8443"]);
  });

  it("treats a missing Origin as same-origin but rejects unknown ones", () => {
    const allowed = ["https://a.example"];
    expect(isAllowedOrigin({ headers: {} }, allowed)).toBe(true);
    expect(isAllowedOrigin({ headers: { origin: "https://a.example" } }, allowed)).toBe(true);
    expect(isAllowedOrigin({ headers: { origin: "https://evil.example" } }, allowed)).toBe(false);
    expect(isAllowedOrigin({ headers: { origin: "null" } }, allowed)).toBe(false);
  });

  it("rejects every Origin when nothing is configured", () => {
    expect(isAllowedOrigin({ headers: { origin: "https://a.example" } }, [])).toBe(false);
  });
});

describe("rate limiting", () => {
  it("limits controller actions per token", async () => {
    const room = await createRoom();
    const controller = await joinRoom(room);

    let limited = false;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const response = await api("get", `/api/v1/rooms/${room.roomId}/queue`)
        .set("Authorization", `Bearer ${controller.token}`);
      if (response.status === 429) {
        limited = true;
        break;
      }
    }
    expect(limited).toBe(true);
  });

  it("caps the number of controllers in a room", async () => {
    const room = await createRoom();
    for (let index = 0; index < 50; index += 1) {
      await api("post", `/api/v1/rooms/${room.roomId}/join`)
        .send({ joinToken: room.joinToken, displayName: `guest${index}` })
        .expect(201);
    }
    const response = await api("post", `/api/v1/rooms/${room.roomId}/join`)
      .send({ joinToken: room.joinToken, displayName: "overflow" })
      .expect(429);
    expect(response.body.error.code).toBe("controller_limit");
  });
});
