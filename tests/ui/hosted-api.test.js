/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CONTROLLER_STORAGE_KEY,
  clearSession,
  consumeJoinFragment,
  hostedApi,
  isSessionRevokedError,
  joinUrlFor,
  partyJoinUrlFor,
  sessionJoinUrlFor,
  readSession,
  writeSession
} from "../../src/lib/hosted-api";

beforeEach(() => {
  sessionStorage.clear();
  vi.restoreAllMocks();
});

function mockFetch(status, body) {
  const spy = vi.fn().mockResolvedValue({
    ok: status < 400,
    status,
    json: async () => body
  });
  vi.stubGlobal("fetch", spy);
  return spy;
}

describe("join fragment", () => {
  it("reads the room and join token from the fragment and strips it", () => {
    const locationLike = {
      hash: "#room=ABCD2345&join=tokentokentokentoken",
      pathname: "/party",
      search: ""
    };
    const historyLike = { replaceState: vi.fn() };

    const result = consumeJoinFragment(locationLike, historyLike);

    expect(result).toEqual({ roomId: "ABCD2345", joinToken: "tokentokentokentoken" });
    // The token must not survive in the address bar where it could be shared.
    expect(historyLike.replaceState).toHaveBeenCalledWith(null, "", "/party");
  });

  it("returns empty values when there is no fragment", () => {
    const historyLike = { replaceState: vi.fn() };
    const result = consumeJoinFragment({ hash: "", pathname: "/party", search: "" }, historyLike);
    expect(result).toEqual({ roomId: "", joinToken: "" });
    expect(historyLike.replaceState).not.toHaveBeenCalled();
  });
});

describe("session storage", () => {
  it("round-trips a session", () => {
    writeSession(CONTROLLER_STORAGE_KEY, { roomId: "ABCD2345", token: "abc", expiresAt: null });
    expect(readSession(CONTROLLER_STORAGE_KEY)).toMatchObject({ roomId: "ABCD2345", token: "abc" });
  });

  it("drops an expired session", () => {
    writeSession(CONTROLLER_STORAGE_KEY, {
      roomId: "ABCD2345",
      token: "abc",
      expiresAt: new Date(Date.now() - 1_000).toISOString()
    });
    expect(readSession(CONTROLLER_STORAGE_KEY)).toBeNull();
  });

  it("ignores malformed stored data", () => {
    sessionStorage.setItem(CONTROLLER_STORAGE_KEY, "{not json");
    expect(readSession(CONTROLLER_STORAGE_KEY)).toBeNull();
  });

  it("clears a session", () => {
    writeSession(CONTROLLER_STORAGE_KEY, { roomId: "ABCD2345", token: "abc" });
    clearSession(CONTROLLER_STORAGE_KEY);
    expect(readSession(CONTROLLER_STORAGE_KEY)).toBeNull();
  });

  it("uses sessionStorage so tokens do not persist after the tab closes", () => {
    writeSession(CONTROLLER_STORAGE_KEY, { roomId: "ABCD2345", token: "secret-token" });
    expect(localStorage.getItem(CONTROLLER_STORAGE_KEY)).toBeNull();
  });
});

describe("request shaping", () => {
  it("sends the bearer token and room-scoped path", async () => {
    const spy = mockFetch(200, { data: { revision: 3 } });
    await hostedApi.queue("ABCD2345", "host-token");

    const [url, options] = spy.mock.calls[0];
    expect(url).toBe("/api/v1/rooms/ABCD2345/queue");
    expect(options.headers.Authorization).toBe("Bearer host-token");
  });

  it("sends JSON content type on mutations", async () => {
    const spy = mockFetch(201, { data: {} });
    await hostedApi.addTrack("ABCD2345", "token", { videoId: "dQw4w9WgXcQ", title: "t" });

    const [, options] = spy.mock.calls[0];
    expect(options.method).toBe("POST");
    expect(options.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(options.body).track.videoId).toBe("dQw4w9WgXcQ");
  });

  it("sends a bearer-authenticated fair queue settings patch", async () => {
    const spy = mockFetch(200, { data: { revision: 4, settings: { fairQueue: true } } });
    await hostedApi.updateSettings("ABCD2345", "controller-token", { fairQueue: true });

    const [url, options] = spy.mock.calls[0];
    expect(url).toBe("/api/v1/rooms/ABCD2345/settings");
    expect(options.method).toBe("PATCH");
    expect(options.headers.Authorization).toBe("Bearer controller-token");
    expect(JSON.parse(options.body)).toEqual({ fairQueue: true });
  });

  it("sends a bearer-authenticated playback patch without putting the token in the URL", async () => {
    const spy = mockFetch(200, {
      data: { revision: 5, playback: { playing: false, volume: 35, muted: true } }
    });
    await hostedApi.updatePlayback("ABCD2345", "controller-secret", {
      playing: false,
      volume: 35,
      muted: true
    });

    const [url, options] = spy.mock.calls[0];
    expect(url).toBe("/api/v1/rooms/ABCD2345/playback");
    expect(url).not.toContain("controller-secret");
    expect(options.method).toBe("PATCH");
    expect(options.headers.Authorization).toBe("Bearer controller-secret");
    expect(JSON.parse(options.body)).toEqual({ playing: false, volume: 35, muted: true });
  });

  it("sends a room-scoped reorder with item, target index, and latest revision", async () => {
    const spy = mockFetch(200, { data: { revision: 9 } });
    await hostedApi.reorder("ABCD2345", "controller-token", "queue-item-8", 0, 8);

    const [url, options] = spy.mock.calls[0];
    expect(url).toBe("/api/v1/rooms/ABCD2345/queue/reorder");
    expect(options.method).toBe("PATCH");
    expect(options.headers.Authorization).toBe("Bearer controller-token");
    expect(JSON.parse(options.body)).toEqual({ itemId: "queue-item-8", toIndex: 0, revision: 8 });
  });

  it("never puts a token in the URL", async () => {
    const spy = mockFetch(200, { data: {} });
    await hostedApi.room("ABCD2345", "super-secret-token");
    expect(spy.mock.calls[0][0]).not.toContain("super-secret-token");
  });

  it("surfaces the server error code and status", async () => {
    mockFetch(409, { error: { code: "revision_conflict", message: "คิวมีการเปลี่ยนแปลง", details: { expectedRevision: 7 } } });
    await expect(hostedApi.skip("ABCD2345", "token", 3)).rejects.toMatchObject({
      code: "revision_conflict",
      status: 409,
      details: { expectedRevision: 7 }
    });
  });

  it("reports a network failure without leaking internals", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED 10.0.0.5:8080")));
    await expect(hostedApi.health()).rejects.toMatchObject({ code: "network_error" });
  });
});

describe("revocation detection", () => {
  it.each([
    "controller_session_expired",
    "host_token_invalid",
    "room_not_found",
    "room_rotated",
    "room_closed",
    "401",
    "403"
  ])("treats %s as a revoked session", (code) => {
    expect(isSessionRevokedError(code)).toBe(true);
  });

  it.each(["revision_conflict", "queue_full", "network_error", "429"])(
    "does not treat %s as revoked",
    (code) => {
      expect(isSessionRevokedError(code)).toBe(false);
    }
  );
});

describe("join url", () => {
  it("builds an absolute url from the hosted origin", () => {
    expect(joinUrlFor("/party#room=ABCD2345&join=xyz", "https://karaoke.example"))
      .toBe("https://karaoke.example/party#room=ABCD2345&join=xyz");
  });

  it("does not create an unusable invite when the join token is missing", () => {
    expect(partyJoinUrlFor("ABCD2345", "", "https://karaoke.example")).toBe("");
  });

  it("builds a shareable room invite with the join token in the fragment", () => {
    expect(partyJoinUrlFor("ABCD2345", "secret-token", "https://karaoke.example"))
      .toBe("https://karaoke.example/party#room=ABCD2345&join=secret-token");
  });

  it("canonicalizes a same-origin stored join path", () => {
    expect(sessionJoinUrlFor({ joinPath: "/party#room=ABCD2345&join=secret-token" }, "https://karaoke.example"))
      .toBe("https://karaoke.example/party#room=ABCD2345&join=secret-token");
  });

  it("rejects external or malformed stored paths and rebuilds the room invite", () => {
    expect(sessionJoinUrlFor({
      roomId: "ABCD2345",
      joinToken: "secret-token",
      joinPath: "https://evil.example/party#room=EVIL&join=leak"
    }, "https://karaoke.example")).toBe("https://karaoke.example/party#room=ABCD2345&join=secret-token");
    expect(sessionJoinUrlFor({
      roomId: "ABCD2345",
      joinToken: "secret-token",
      joinPath: "javascript:alert(1)"
    }, "https://karaoke.example")).toBe("https://karaoke.example/party#room=ABCD2345&join=secret-token");
    expect(sessionJoinUrlFor({
      roomId: "ABCD2345",
      joinToken: "secret-token",
      joinPath: "/party?redirect=https://evil.example/party#room=EVIL&join=leak"
    }, "https://karaoke.example")).toBe("https://karaoke.example/party#room=ABCD2345&join=secret-token");
  });
});
