import path from "node:path";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHostedApplication } from "../../server/hosted/app.js";
import { MemoryRoomStore } from "../../server/hosted/rooms.js";

const ORIGIN = "https://karaoke.example";
const videoA = {
  videoId: "dQw4w9WgXcQ",
  title: "เพลงทดสอบ",
  channelTitle: "ช่องทดสอบ",
  thumbnailUrl: "https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg"
};

let runtime;

beforeEach(async () => {
  runtime = await createHostedApplication({
    env: {
      YOUTUBE_API_KEY: "very-secret-key",
      ALLOWED_ORIGINS: ORIGIN
    },
    distDir: path.join(process.cwd(), "missing-dist"),
    fetchImpl: vi.fn(),
    store: new MemoryRoomStore()
  });
});

function api(method, url) {
  return request(runtime.app)[method](url).set("Content-Type", "application/json");
}

async function createRoom() {
  const response = await api("post", "/api/v1/rooms").send({}).expect(201);
  return response.body.data;
}

async function joinRoom(room, displayName) {
  const response = await api("post", `/api/v1/rooms/${room.roomId}/join`)
    .send({ joinToken: room.joinToken, displayName })
    .expect(201);
  return response.body.data;
}

describe("party leader and members", () => {
  it("makes the first QR join the party leader", async () => {
    const room = await createRoom();
    const first = await joinRoom(room, "นัท");
    const second = await joinRoom(room, "โบ๊ท");
    expect(first.isLeader).toBe(true);
    expect(second.isLeader).toBe(false);
    expect(first.controllerId).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it("lets only the leader kick, keeps the queue, and allows rejoin", async () => {
    const room = await createRoom();
    const leader = await joinRoom(room, "นัท");
    const guest = await joinRoom(room, "โบ๊ท");
    await api("post", `/api/v1/rooms/${room.roomId}/queue`)
      .set("Authorization", `Bearer ${guest.token}`)
      .send({ track: videoA })
      .expect(201);

    await api("post", `/api/v1/rooms/${room.roomId}/members/${guest.controllerId}/kick`)
      .set("Authorization", `Bearer ${leader.token}`)
      .send({})
      .expect(200);

    const queue = await api("get", `/api/v1/rooms/${room.roomId}/queue`)
      .set("Authorization", `Bearer ${leader.token}`)
      .expect(200);
    expect(queue.body.data.current?.videoId || queue.body.data.queue?.[0]?.videoId).toBe(videoA.videoId);

    await api("get", `/api/v1/rooms/${room.roomId}/queue`)
      .set("Authorization", `Bearer ${guest.token}`)
      .expect(401);

    const rejoined = await joinRoom(room, "โบ๊ท");
    expect(rejoined.isLeader).toBe(false);
    expect(rejoined.controllerId).not.toBe(guest.controllerId);
  });

  it("rejects a kick from a non-leader", async () => {
    const room = await createRoom();
    const leader = await joinRoom(room, "นัท");
    const guest = await joinRoom(room, "โบ๊ท");
    const response = await api("post", `/api/v1/rooms/${room.roomId}/members/${leader.controllerId}/kick`)
      .set("Authorization", `Bearer ${guest.token}`)
      .send({})
      .expect(403);
    expect(response.body.error.code).toBe("kick_forbidden");
  });

  it("transfers leadership when the leader leaves", async () => {
    const room = await createRoom();
    const leader = await joinRoom(room, "นัท");
    const nextLeader = await joinRoom(room, "โบ๊ท");
    const guest = await joinRoom(room, "เฟลิกซ์");

    await api("post", `/api/v1/rooms/${room.roomId}/leave`)
      .set("Authorization", `Bearer ${leader.token}`)
      .send({})
      .expect(200);

    expect(runtime.store.require(room.roomId).partyLeaderId).toBe(nextLeader.controllerId);

    await api("post", `/api/v1/rooms/${room.roomId}/members/${guest.controllerId}/kick`)
      .set("Authorization", `Bearer ${nextLeader.token}`)
      .send({})
      .expect(200);
  });
});
