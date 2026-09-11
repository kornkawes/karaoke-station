import path from "node:path";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHostedApplication, isAllowedOrigin, parseAllowedOrigins } from "../../server/hosted/app.js";
import {
  MemoryRoomStore,
  ROOM_IDLE_CLOSE_MS,
  ROOM_IDLE_WARNING_MS
} from "../../server/hosted/rooms.js";

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
const videoC = {
  videoId: "zyxwvutsrqp",
  title: "Third song",
  channelTitle: "Channel",
  thumbnailUrl: "https://i.ytimg.com/vi/zyxwvutsrqp/mqdefault.jpg"
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

  it("lets a controller toggle fair queue but keeps other settings host-only", async () => {
    const room = await createRoom();
    const controller = await joinRoom(room);

    const enabled = await api("patch", `/api/v1/rooms/${room.roomId}/settings`)
      .set("Authorization", `Bearer ${controller.token}`)
      .send({ fairQueue: true })
      .expect(200);
    expect(enabled.body.data.settings).toEqual({ fairQueue: true });

    const memberView = await api("get", `/api/v1/rooms/${room.roomId}/queue`)
      .set("Authorization", `Bearer ${controller.token}`)
      .expect(200);
    expect(memberView.body.data.settings).toEqual({ fairQueue: true });

    await api("patch", `/api/v1/rooms/${room.roomId}/settings`)
      .set("Authorization", `Bearer ${controller.token}`)
      .send({ stationName: "ยึดห้อง" })
      .expect(403);
  });

  it("rebalances an existing queue when fair mode opens and restores arrival order when it closes", async () => {
    const room = await createRoom();
    const alice = await joinRoom(room, "Alice");
    const bob = await joinRoom(room, "Bob");

    await addTrack(room, alice.token, videoA).expect(201);
    clock.value += 1;
    await addTrack(room, alice.token, videoB).expect(201);
    clock.value += 1;
    await addTrack(room, bob.token, videoC).expect(201);

    await api("patch", `/api/v1/rooms/${room.roomId}/settings`)
      .set("Authorization", `Bearer ${alice.token}`)
      .send({ fairQueue: true })
      .expect(200);
    const fair = await api("get", `/api/v1/rooms/${room.roomId}/queue`)
      .set("Authorization", `Bearer ${alice.token}`)
      .expect(200);
    expect(fair.body.data.queue.map((item) => item.videoId)).toEqual([videoC.videoId, videoB.videoId]);

    await api("patch", `/api/v1/rooms/${room.roomId}/settings`)
      .set("Authorization", `Bearer ${alice.token}`)
      .send({ fairQueue: false })
      .expect(200);
    const chronological = await api("get", `/api/v1/rooms/${room.roomId}/queue`)
      .set("Authorization", `Bearer ${alice.token}`)
      .expect(200);
    expect(chronological.body.data.queue.map((item) => item.videoId)).toEqual([videoB.videoId, videoC.videoId]);
  });

  it("lets a controller complete the current song and records completed history", async () => {
    const room = await createRoom();
    const controller = await joinRoom(room);

    await addTrack(room, room.hostToken, videoA).expect(201);
    await addTrack(room, controller.token, videoB).expect(201);
    const before = await api("get", `/api/v1/rooms/${room.roomId}/queue`)
      .set("Authorization", `Bearer ${controller.token}`)
      .expect(200);

    await api("post", `/api/v1/rooms/${room.roomId}/queue/complete`)
      .set("Authorization", `Bearer ${controller.token}`)
      .send({ revision: before.body.data.revision })
      .expect(200);

    const history = await api("get", `/api/v1/rooms/${room.roomId}/history`)
      .set("Authorization", `Bearer ${controller.token}`)
      .expect(200);
    expect(history.body.data.history[0]).toMatchObject({ title: videoA.title, status: "completed" });
    const after = await api("get", `/api/v1/rooms/${room.roomId}/queue`)
      .set("Authorization", `Bearer ${controller.token}`)
      .expect(200);
    expect(after.body.data.current.title).toBe(videoB.title);
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

describe("connected-controller idle policy", () => {
  it("warns after five minutes and expires ten minutes after the live controller arrives", () => {
    const store = new MemoryRoomStore({ now: () => clock.value });
    const room = store.create();

    // A registered controller without a live socket must not start the idle clock.
    expect(store.sweepIdle()).toEqual({ warnings: [], expired: [] });
    store.setConnectedControllerCount(room.roomId, 1);

    clock.value += ROOM_IDLE_WARNING_MS - 1;
    expect(store.sweepIdle()).toEqual({ warnings: [], expired: [] });

    clock.value += 1;
    const warning = store.sweepIdle();
    expect(warning.warnings).toHaveLength(1);
    expect(warning.warnings[0]).toMatchObject({
      roomId: room.roomId,
      closesAt: clock.value + ROOM_IDLE_WARNING_MS
    });

    // The warning is emitted once, not on every one-second sweep.
    expect(store.sweepIdle()).toEqual({ warnings: [], expired: [] });

    clock.value += ROOM_IDLE_CLOSE_MS - ROOM_IDLE_WARNING_MS - 1;
    expect(store.sweepIdle()).toEqual({ warnings: [], expired: [] });
    clock.value += 1;
    expect(store.sweepIdle().expired).toEqual([
      expect.objectContaining({ roomId: room.roomId })
    ]);
    expect(store.get(room.roomId)).toBeUndefined();
  });

  it("keeps a room alive when another controller remains and resets the warning on activity", () => {
    const store = new MemoryRoomStore({ now: () => clock.value });
    const room = store.create();
    store.setConnectedControllerCount(room.roomId, 2);

    clock.value += ROOM_IDLE_WARNING_MS;
    expect(store.sweepIdle().warnings).toHaveLength(1);

    // One phone disconnects; the second live phone still keeps the room usable.
    store.setConnectedControllerCount(room.roomId, 1);
    expect(store.sweepIdle()).toEqual({ warnings: [], expired: [] });

    // A meaningful mutation clears the warning and starts a fresh idle window
    // only when the room is empty again.
    store.recordActivity(room.roomId);
    clock.value += ROOM_IDLE_WARNING_MS - 1;
    expect(store.sweepIdle()).toEqual({ warnings: [], expired: [] });
    clock.value += 1;
    expect(store.sweepIdle().warnings).toHaveLength(1);
  });

  it("does not expire a connected room while it has a selected song", () => {
    const store = new MemoryRoomStore({ now: () => clock.value });
    const room = store.create();
    store.setConnectedControllerCount(room.roomId, 1);
    room.state.current = { id: "current", videoId: "dQw4w9WgXcQ", title: "เพลงที่กำลังเล่น" };

    clock.value += ROOM_IDLE_CLOSE_MS * 2;
    expect(store.sweepIdle()).toEqual({ warnings: [], expired: [] });
    expect(store.get(room.roomId)).toBeDefined();
  });

  it("recovers from malformed idle timestamps instead of wedging the room", () => {
    const store = new MemoryRoomStore({ now: () => clock.value });
    const room = store.create();
    store.setConnectedControllerCount(room.roomId, 1, "not-a-date");

    clock.value += ROOM_IDLE_WARNING_MS;
    expect(store.sweepIdle().warnings).toHaveLength(1);

    const freshRoom = store.get(room.roomId);
    freshRoom.idleSinceAt = "not-a-date";
    freshRoom.idleWarningAt = null;
    expect(store.sweepIdle()).toEqual({ warnings: [], expired: [] });
    expect(Number.isFinite(Number(freshRoom.idleSinceAt))).toBe(true);
  });

  it("starts a fresh idle window after the last queued song is removed", async () => {
    const store = new MemoryRoomStore({ now: () => clock.value });
    const room = store.create();
    store.setConnectedControllerCount(room.roomId, 1);
    room.state.queue.push({ id: "queued", videoId: "dQw4w9WgXcQ", title: "เพลงในคิว" });

    clock.value += ROOM_IDLE_CLOSE_MS * 2;
    expect(store.sweepIdle()).toEqual({ warnings: [], expired: [] });

    await store.mutate(room.roomId, (draft) => {
      draft.queue = [];
    });
    clock.value += ROOM_IDLE_WARNING_MS - 1;
    expect(store.sweepIdle()).toEqual({ warnings: [], expired: [] });
    clock.value += 1;
    expect(store.sweepIdle().warnings).toHaveLength(1);
  });

  it("exposes the warning countdown in the host room view", async () => {
    const room = await createRoom();
    runtime.store.setConnectedControllerCount(room.roomId, 1);
    clock.value += ROOM_IDLE_WARNING_MS;
    runtime.store.sweepIdle();

    const response = await api("get", `/api/v1/rooms/${room.roomId}`)
      .set("Authorization", `Bearer ${room.hostToken}`)
      .expect(200);
    expect(response.body.data.connectedControllerCount).toBe(1);
    expect(response.body.data.idle).toMatchObject({ warning: true, phase: "warning" });
    expect(response.body.data.idle.closesAt).toBe(new Date(clock.value + ROOM_IDLE_WARNING_MS).toISOString());
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

  it("rebalances the queue after enabling fair mode and keeps requester identity private", async () => {
    const room = await createRoom();
    const alice = await joinRoom(room, "Alice");
    const bob = await joinRoom(room, "Bob");

    await api("patch", `/api/v1/rooms/${room.roomId}/settings`)
      .set("Authorization", `Bearer ${room.hostToken}`)
      .send({ fairQueue: true })
      .expect(200);
    await addTrack(room, alice.token, videoA).expect(201);
    await addTrack(room, bob.token, videoB).expect(201);
    await addTrack(room, alice.token, videoC).expect(201);

    const view = await api("get", `/api/v1/rooms/${room.roomId}/queue`)
      .set("Authorization", `Bearer ${room.hostToken}`)
      .expect(200);
    expect(view.body.data.queue.map((item) => item.videoId)).toEqual([videoB.videoId, videoC.videoId]);
    expect(view.body.data.queue.map((item) => item.requestedBy)).toEqual(["Bob", "Alice"]);
    expect(JSON.stringify(view.body)).not.toContain("_requesterKey");
    expect(JSON.stringify(view.body)).not.toContain(bob.token);
  });

  it("returns a safe upstream error when direct-link metadata cannot be verified", async () => {
    const room = await createRoom();
    const response = await api("post", `/api/v1/rooms/${room.roomId}/youtube/resolve`)
      .set("Authorization", `Bearer ${room.hostToken}`)
      .send({ input: "dQw4w9WgXcQ" });

    expect(response.status).toBe(502);
    expect(response.body.error.code).toBe("youtube_unavailable");
    expect(response.body.data).toBeUndefined();
  });
});

describe("shared playback controls", () => {
  it("lets a controller change playback and publishes the new room snapshot", async () => {
    const room = await createRoom();
    const controller = await joinRoom(room);
    const changed = new Promise((resolve) => runtime.events.once("room:changed", resolve));

    const response = await api("patch", `/api/v1/rooms/${room.roomId}/playback`)
      .set("Authorization", `Bearer ${controller.token}`)
      .send({ playing: false, volume: 42, muted: true })
      .expect(200);
    const event = await changed;

    expect(response.body.data).toEqual({
      revision: 1,
      playback: { playing: false, volume: 42, muted: true }
    });
    expect(event).toMatchObject({
      roomId: room.roomId,
      view: {
        revision: 1,
        playback: { playing: false, volume: 42, muted: true }
      }
    });
    expect(JSON.stringify(event)).not.toContain(controller.token);
    expect(JSON.stringify(event)).not.toContain(room.hostToken);
    expect(JSON.stringify(event)).not.toContain(room.joinToken);
  });

  it("lets the host use the same endpoint and exposes playback in room views", async () => {
    const room = await createRoom();

    await api("patch", `/api/v1/rooms/${room.roomId}/playback`)
      .set("Authorization", `Bearer ${room.hostToken}`)
      .send({ volume: 0 })
      .expect(200);

    const view = await api("get", `/api/v1/rooms/${room.roomId}`)
      .set("Authorization", `Bearer ${room.hostToken}`)
      .expect(200);
    expect(view.body.data.playback).toEqual({ playing: true, volume: 0, muted: false });
  });

  it.each([
    [{}, "empty patch"],
    [{ volume: -1 }, "volume below zero"],
    [{ volume: 101 }, "volume above one hundred"],
    [{ volume: 42.5 }, "fractional volume"],
    [{ playing: "yes" }, "non-boolean playing"],
    [{ muted: 1 }, "non-boolean muted"],
    [{ volume: 50, token: "secret" }, "unknown property"]
  ])("rejects %s (%s) without changing state", async (patch) => {
    const room = await createRoom();

    const response = await api("patch", `/api/v1/rooms/${room.roomId}/playback`)
      .set("Authorization", `Bearer ${room.hostToken}`)
      .send(patch)
      .expect(400);

    expect(response.body.error.code).toBe("validation_error");
    expect(runtime.store.require(room.roomId).state.playback).toEqual({
      playing: true,
      volume: 75,
      muted: false
    });
    expect(runtime.store.require(room.roomId).state.revision).toBe(0);
  });

  it("rejects missing, cross-room, and expired controller credentials", async () => {
    const roomA = await createRoom();
    const roomB = await createRoom();
    const controllerA = await joinRoom(roomA);

    await api("patch", `/api/v1/rooms/${roomA.roomId}/playback`)
      .send({ muted: true })
      .expect(401);
    await api("patch", `/api/v1/rooms/${roomB.roomId}/playback`)
      .set("Authorization", `Bearer ${controllerA.token}`)
      .send({ muted: true })
      .expect(401);

    runtime.store.require(roomA.roomId).controllers.get(controllerA.token).expiresAt = clock.value - 1;
    const expired = await api("patch", `/api/v1/rooms/${roomA.roomId}/playback`)
      .set("Authorization", `Bearer ${controllerA.token}`)
      .send({ muted: true })
      .expect(401);
    expect(expired.body.error.code).toBe("controller_session_expired");
    expect(runtime.store.require(roomA.roomId).state.playback.muted).toBe(false);
  });

  it("serializes partial updates so concurrent controls do not erase each other", async () => {
    const room = await createRoom();
    const controller = await joinRoom(room);

    await Promise.all([
      api("patch", `/api/v1/rooms/${room.roomId}/playback`)
        .set("Authorization", `Bearer ${room.hostToken}`)
        .send({ volume: 18 })
        .expect(200),
      api("patch", `/api/v1/rooms/${room.roomId}/playback`)
        .set("Authorization", `Bearer ${controller.token}`)
        .send({ muted: true })
        .expect(200)
    ]);

    expect(runtime.store.require(room.roomId).state.playback).toEqual({
      playing: true,
      volume: 18,
      muted: true
    });
    expect(runtime.store.require(room.roomId).state.revision).toBe(2);
  });

  it("starts a promoted track and stops playback when the queue becomes empty", async () => {
    const room = await createRoom();
    const controller = await joinRoom(room);

    await api("patch", `/api/v1/rooms/${room.roomId}/playback`)
      .set("Authorization", `Bearer ${controller.token}`)
      .send({ playing: false })
      .expect(200);
    await addTrack(room, controller.token, videoA).expect(201);
    expect(runtime.store.require(room.roomId).state.playback.playing).toBe(true);

    await api("post", `/api/v1/rooms/${room.roomId}/queue/skip`)
      .set("Authorization", `Bearer ${controller.token}`)
      .send({})
      .expect(200);
    expect(runtime.store.require(room.roomId).state.current).toBeNull();
    expect(runtime.store.require(room.roomId).state.playback.playing).toBe(false);
  });
});

describe("secret non-disclosure", () => {
  it("reports search readiness without exposing configuration details", async () => {
    const response = await api("get", "/api/v1/health").expect(200);
    expect(response.body.data.searchConfigured).toBe(true);
    expect(JSON.stringify(response.body)).not.toContain("very-secret-key");
  });

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
    expect(response.headers["content-security-policy"]).toContain("https://fonts.googleapis.com");
    expect(response.headers["content-security-policy"]).toContain("https://fonts.gstatic.com");
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

  it("rejects an unsafe proxy-hop configuration instead of trusting arbitrary headers", async () => {
    const unsafe = await createHostedApplication({
      env: { ALLOWED_ORIGINS: ORIGIN, TRUSTED_PROXY: "999" },
      distDir: path.join(process.cwd(), "missing-dist"),
      fetchImpl: vi.fn()
    });
    expect(unsafe.app.get("trust proxy")).toBe(false);
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

  it("limits host actions per token", async () => {
    const room = await createRoom();

    let limited = false;
    for (let attempt = 0; attempt < 130; attempt += 1) {
      const response = await api("get", `/api/v1/rooms/${room.roomId}/queue`)
        .set("Authorization", `Bearer ${room.hostToken}`);
      if (response.status === 429) {
        expect(response.body.error.code).toBe("rate_limited");
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

describe("lyrics capacity", () => {
  function saveLyric(room, videoId, content) {
    return api("put", `/api/v1/rooms/${room.roomId}/lyrics/${videoId}`)
      .set("Authorization", `Bearer ${room.hostToken}`)
      .send({ kind: "plain", content, source: "manual" });
  }

  it("caps the number of lyrics records retained by a room", async () => {
    const room = await createRoom();
    for (let index = 0; index < 100; index += 1) {
      await saveLyric(room, String(index).padStart(11, "0"), "test").expect(200);
    }
    const response = await saveLyric(room, "99999999999", "overflow").expect(413);
    expect(response.body.error.code).toBe("lyrics_capacity");
  });

  it("caps aggregate UTF-8 lyric content while allowing replacement", async () => {
    const room = await createRoom();
    const chunk = "ก".repeat(20_000); // 60,000 UTF-8 bytes
    for (let index = 0; index < 16; index += 1) {
      await saveLyric(room, String(index).padStart(11, "0"), chunk).expect(200);
    }
    const response = await saveLyric(room, "99999999999", chunk).expect(413);
    expect(response.body.error.code).toBe("lyrics_capacity");

    await saveLyric(room, "00000000000", "replacement").expect(200);
  });
});
