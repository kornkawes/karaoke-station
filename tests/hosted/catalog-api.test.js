import path from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHostedApplication } from "../../server/hosted/app.js";

const missingDist = path.join(process.cwd(), "missing-dist");
const videoA = {
  videoId: "dQw4w9WgXcQ",
  title: "เพลงทดสอบ ก",
  channelTitle: "ช่อง ก"
};
const videoB = {
  videoId: "abcdefghijk",
  title: "เพลงทดสอบ ข",
  channelTitle: "ช่อง ข"
};

let runtime;
let catalog;

beforeEach(async () => {
  catalog = {
    listSuggestions: vi.fn(async () => ({
      suggestions: [{
        artist: "ศิลปิน ก",
        title: "เพลงทดสอบ ก",
        videoId: videoA.videoId,
        channelTitle: videoA.channelTitle
      }]
    })),
    remember: vi.fn(async () => true)
  };
  runtime = await createHostedApplication({
    env: { ALLOWED_ORIGINS: "https://karaoke.example", YOUTUBE_API_KEY: "" },
    distDir: missingDist,
    catalog,
    // The catalog tests use a fake source; model the successful server-side
    // provenance check without making any upstream network call.
    catalogTrackVerifier: async (track) => track
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function api(method, url) {
  return request(runtime.app)[method](url).set("Content-Type", "application/json");
}

async function createRoom() {
  return (await api("post", "/api/v1/rooms").send({}).expect(201)).body.data;
}

describe("hosted catalog suggestions", () => {
  it("requires room membership and returns the shared frontend contract", async () => {
    const room = await createRoom();
    await api("get", `/api/v1/rooms/${room.roomId}/catalog/suggestions?q=เพลง&limit=6`)
      .expect(401);

    const response = await api(
      "get",
      `/api/v1/rooms/${room.roomId}/catalog/suggestions?q=${encodeURIComponent("เพลง ก")}&limit=6`
    )
      .set("Authorization", `Bearer ${room.hostToken}`)
      .expect(200);

    expect(catalog.listSuggestions).toHaveBeenCalledWith({ query: "เพลง ก", limit: "6" });
    expect(response.body).toEqual({
      data: {
        suggestions: [{
          artist: "ศิลปิน ก",
          title: "เพลงทดสอบ ก",
          videoId: videoA.videoId,
          channelTitle: videoA.channelTitle
        }]
      }
    });
  });

  it("can inject a fake catalog source and starts without Google credentials", async () => {
    const source = {
      load: vi.fn(async () => [
        ["artist", "title", "videoId"],
        ["Artist", "Source song", "zyxwvutsrqp"]
      ]),
      append: vi.fn()
    };
    const sourcedRuntime = await createHostedApplication({
      env: { ALLOWED_ORIGINS: "https://karaoke.example" },
      distDir: missingDist,
      catalogSource: source
    });
    const room = (await request(sourcedRuntime.app)
      .post("/api/v1/rooms")
      .set("Content-Type", "application/json")
      .send({})
      .expect(201)).body.data;
    const response = await request(sourcedRuntime.app)
      .get(`/api/v1/rooms/${room.roomId}/catalog/suggestions?q=source&limit=8`)
      .set("Content-Type", "application/json")
      .set("Authorization", `Bearer ${room.hostToken}`)
      .expect(200);
    expect(response.body.data.suggestions).toEqual([{
      artist: "Artist",
      title: "Source song",
      videoId: "zyxwvutsrqp",
      youtubeUrl: "https://www.youtube.com/watch?v=zyxwvutsrqp",
      aliases: []
    }]);

    const emptyRuntime = await createHostedApplication({
      env: { ALLOWED_ORIGINS: "https://karaoke.example" },
      distDir: missingDist
    });
    const emptyRoom = (await request(emptyRuntime.app)
      .post("/api/v1/rooms")
      .set("Content-Type", "application/json")
      .send({})
      .expect(201)).body.data;
    const emptyResponse = await request(emptyRuntime.app)
      .get(`/api/v1/rooms/${emptyRoom.roomId}/catalog/suggestions?q=song&limit=8`)
      .set("Content-Type", "application/json")
      .set("Authorization", `Bearer ${emptyRoom.hostToken}`)
      .expect(200);
    expect(emptyResponse.body.data).toEqual({ suggestions: [] });
  });
});

describe("hosted catalog auto-learn", () => {
  it("learns successful queue adds without waiting for the append", async () => {
    let finishRemember;
    catalog.remember.mockImplementation(() => new Promise((resolve) => { finishRemember = resolve; }));
    const room = await createRoom();

    const response = await api("post", `/api/v1/rooms/${room.roomId}/queue`)
      .set("Authorization", `Bearer ${room.hostToken}`)
      .send({ track: videoA })
      .expect(201);

    expect(response.body.data.item.videoId).toBe(videoA.videoId);
    await vi.waitFor(() => expect(catalog.remember).toHaveBeenCalledWith(
      expect.objectContaining(videoA)
    ));
    finishRemember(true);
  });

  it("learns the selected track after play-now", async () => {
    const room = await createRoom();
    await api("post", `/api/v1/rooms/${room.roomId}/queue`)
      .set("Authorization", `Bearer ${room.hostToken}`)
      .send({ track: videoA })
      .expect(201);
    const queued = await api("post", `/api/v1/rooms/${room.roomId}/queue`)
      .set("Authorization", `Bearer ${room.hostToken}`)
      .send({ track: videoB })
      .expect(201);
    await vi.waitFor(() => expect(catalog.remember).toHaveBeenCalledTimes(2));
    catalog.remember.mockClear();

    await api("post", `/api/v1/rooms/${room.roomId}/queue/play-now`)
      .set("Authorization", `Bearer ${room.hostToken}`)
      .send({ itemId: queued.body.data.item.id, revision: queued.body.data.revision })
      .expect(200);

    await vi.waitFor(() => expect(catalog.remember).toHaveBeenCalledWith(
      expect.objectContaining({ videoId: videoB.videoId, title: videoB.title })
    ));
  });

  it("returns a newly learned track on the next suggestion read and skips duplicate video IDs", async () => {
    const rows = [["artist", "title", "videoId", "channelTitle"]];
    const source = {
      load: vi.fn(async () => rows.map((row) => [...row])),
      append: vi.fn(async (track) => {
        rows.push([track.artist, track.title, track.videoId, track.channelTitle]);
      })
    };
    const verifier = vi.fn(async (track) => ({
      ...track,
      artist: "Artist from YouTube",
      title: "เพลงที่ยืนยันแล้ว",
      channelTitle: "Official Channel"
    }));
    const sourcedRuntime = await createHostedApplication({
      env: { ALLOWED_ORIGINS: "https://karaoke.example", YOUTUBE_API_KEY: "" },
      distDir: missingDist,
      catalogSource: source,
      catalogTrackVerifier: verifier
    });
    const room = (await request(sourcedRuntime.app)
      .post("/api/v1/rooms")
      .set("Content-Type", "application/json")
      .send({})
      .expect(201)).body.data;
    const track = { videoId: videoB.videoId, title: "ชื่อจากมือถือ", channelTitle: "ชื่อปลอมก่อนยืนยัน" };

    await request(sourcedRuntime.app)
      .post(`/api/v1/rooms/${room.roomId}/queue`)
      .set("Content-Type", "application/json")
      .set("Authorization", `Bearer ${room.hostToken}`)
      .send({ track })
      .expect(201);
    await vi.waitFor(() => expect(source.append).toHaveBeenCalledTimes(1));

    const firstSuggestionRead = await request(sourcedRuntime.app)
      .get(`/api/v1/rooms/${room.roomId}/catalog/suggestions?q=${encodeURIComponent("เพลงที่ยืนยันแล้ว")}`)
      .set("Authorization", `Bearer ${room.hostToken}`)
      .expect(200);
    expect(firstSuggestionRead.body.data.suggestions).toEqual([
      expect.objectContaining({
        artist: "Artist from YouTube",
        title: "เพลงที่ยืนยันแล้ว",
        videoId: videoB.videoId,
        channelTitle: "Official Channel"
      })
    ]);

    await request(sourcedRuntime.app)
      .post(`/api/v1/rooms/${room.roomId}/queue`)
      .set("Content-Type", "application/json")
      .set("Authorization", `Bearer ${room.hostToken}`)
      .send({ track, allowDuplicate: true })
      .expect(201);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(source.append).toHaveBeenCalledTimes(1);

    const secondSuggestionRead = await request(sourcedRuntime.app)
      .get(`/api/v1/rooms/${room.roomId}/catalog/suggestions?q=${encodeURIComponent("เพลงที่ยืนยันแล้ว")}`)
      .set("Authorization", `Bearer ${room.hostToken}`)
      .expect(200);
    expect(secondSuggestionRead.body.data.suggestions).toHaveLength(1);
  });

  it("does not fail a queue mutation when auto-learn rejects", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    catalog.remember.mockRejectedValue(new Error("sheet unavailable"));
    const room = await createRoom();

    await api("post", `/api/v1/rooms/${room.roomId}/queue`)
      .set("Authorization", `Bearer ${room.hostToken}`)
      .send({ track: videoA })
      .expect(201);
    await vi.waitFor(() => expect(console.error).toHaveBeenCalledWith(
      "catalog auto-learn failed",
      { action: "queue_add", code: "catalog_append_failed" }
    ));
  });

  it("does not let a controller persist a forged track without server verification", async () => {
    const secureCatalog = { remember: vi.fn(async () => true), listSuggestions: vi.fn(async () => ({ suggestions: [] })) };
    const upstream = vi.fn(async () => ({
      ok: false,
      status: 404,
      json: async () => ({})
    }));
    const secureRuntime = await createHostedApplication({
      env: { ALLOWED_ORIGINS: "https://karaoke.example", YOUTUBE_API_KEY: "" },
      distDir: missingDist,
      fetchImpl: upstream,
      catalog: secureCatalog
    });
    const room = (await request(secureRuntime.app)
      .post("/api/v1/rooms")
      .set("Content-Type", "application/json")
      .send({})
      .expect(201)).body.data;
    const controller = (await request(secureRuntime.app)
      .post(`/api/v1/rooms/${room.roomId}/join`)
      .set("Content-Type", "application/json")
      .send({ joinToken: room.joinToken, displayName: "มือถือปลอม" })
      .expect(201)).body.data;

    await request(secureRuntime.app)
      .post(`/api/v1/rooms/${room.roomId}/queue`)
      .set("Content-Type", "application/json")
      .set("Authorization", `Bearer ${controller.token}`)
      .send({ track: { videoId: videoA.videoId, title: "ชื่อเพลงปลอมจากมือถือ", channelTitle: "ช่องปลอม" } })
      .expect(201);

    await vi.waitFor(() => expect(upstream).toHaveBeenCalled());
    expect(secureCatalog.remember).not.toHaveBeenCalled();
  });

  it("learns a controller track only after the server verifier returns metadata", async () => {
    const verifiedCatalog = { remember: vi.fn(async () => true), listSuggestions: vi.fn(async () => ({ suggestions: [] })) };
    const verifier = vi.fn(async (track) => ({
      ...track,
      title: "ชื่อเพลงยืนยันแล้ว",
      channelTitle: "ช่องจริง"
    }));
    const verifiedRuntime = await createHostedApplication({
      env: { ALLOWED_ORIGINS: "https://karaoke.example", YOUTUBE_API_KEY: "" },
      distDir: missingDist,
      catalog: verifiedCatalog,
      catalogTrackVerifier: verifier
    });
    const room = (await request(verifiedRuntime.app)
      .post("/api/v1/rooms")
      .set("Content-Type", "application/json")
      .send({})
      .expect(201)).body.data;
    const controller = (await request(verifiedRuntime.app)
      .post(`/api/v1/rooms/${room.roomId}/join`)
      .set("Content-Type", "application/json")
      .send({ joinToken: room.joinToken, displayName: "มือถือจริง" })
      .expect(201)).body.data;

    await request(verifiedRuntime.app)
      .post(`/api/v1/rooms/${room.roomId}/queue`)
      .set("Content-Type", "application/json")
      .set("Authorization", `Bearer ${controller.token}`)
      .send({ track: videoA })
      .expect(201);

    await vi.waitFor(() => expect(verifiedCatalog.remember).toHaveBeenCalledWith(expect.objectContaining({
      videoId: videoA.videoId,
      title: "ชื่อเพลงยืนยันแล้ว",
      channelTitle: "ช่องจริง"
    })));
    expect(verifier).toHaveBeenCalledWith(expect.objectContaining({
      videoId: videoA.videoId,
      title: videoA.title,
      channelTitle: videoA.channelTitle
    }));
  });

  it("skips verification and learning entirely when the catalog is unconfigured", async () => {
    const verifier = vi.fn();
    const upstream = vi.fn();
    const emptyRuntime = await createHostedApplication({
      env: { ALLOWED_ORIGINS: "https://karaoke.example", YOUTUBE_API_KEY: "" },
      distDir: missingDist,
      fetchImpl: upstream,
      catalogTrackVerifier: verifier
    });
    const room = (await request(emptyRuntime.app)
      .post("/api/v1/rooms")
      .set("Content-Type", "application/json")
      .send({})
      .expect(201)).body.data;
    const controller = (await request(emptyRuntime.app)
      .post(`/api/v1/rooms/${room.roomId}/join`)
      .set("Content-Type", "application/json")
      .send({ joinToken: room.joinToken, displayName: "มือถือว่าง" })
      .expect(201)).body.data;

    await request(emptyRuntime.app)
      .post(`/api/v1/rooms/${room.roomId}/queue`)
      .set("Content-Type", "application/json")
      .set("Authorization", `Bearer ${controller.token}`)
      .send({ track: videoA })
      .expect(201);

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(verifier).not.toHaveBeenCalled();
    expect(upstream).not.toHaveBeenCalled();
  });
});
