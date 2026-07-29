import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { generatePartyPin } from "../../server/lib/schemas.js";
import { JsonRepository } from "../../server/lib/store.js";

const tempDirs = [];

async function tempDirectory() {
  const directory = await mkdtemp(path.join(tmpdir(), "karaoke-store-"));
  tempDirs.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("JsonRepository", () => {
  it("serializes concurrent writes and keeps secrets separate", async () => {
    const dataDir = await tempDirectory();
    const repository = await new JsonRepository({ dataDir, envApiKey: "env-secret" }).init();

    await Promise.all(Array.from({ length: 20 }, (_, index) => repository.mutate((draft) => {
      draft.settings.stationName = `สถานี ${index}`;
    })));

    const state = JSON.parse(await readFile(path.join(dataDir, "state.json"), "utf8"));
    const backup = JSON.parse(await readFile(path.join(dataDir, "state.json.bak"), "utf8"));
    const secrets = JSON.parse(await readFile(path.join(dataDir, "secrets.json"), "utf8"));
    expect(state.revision).toBe(20);
    expect(backup.revision).toBe(19);
    expect(JSON.stringify(state)).not.toContain("env-secret");
    expect(secrets.youtubeApiKey).toBe("env-secret");
  });

  it("recovers state from the last valid backup", async () => {
    const dataDir = await tempDirectory();
    const repository = await new JsonRepository({ dataDir }).init();
    await repository.mutate((draft) => {
      draft.settings.stationName = "สำรองที่ใช้ได้";
    });
    await repository.mutate((draft) => {
      draft.settings.stationName = "ค่าล่าสุด";
    });
    await writeFile(path.join(dataDir, "state.json"), "{corrupt", "utf8");

    const recovered = await new JsonRepository({ dataDir }).init();
    expect(recovered.snapshot().settings.stationName).toBe("สำรองที่ใช้ได้");

    const repairedMain = JSON.parse(await readFile(path.join(dataDir, "state.json"), "utf8"));
    const preservedBackup = JSON.parse(await readFile(path.join(dataDir, "state.json.bak"), "utf8"));
    expect(repairedMain.settings.stationName).toBe("สำรองที่ใช้ได้");
    expect(preservedBackup.settings.stationName).toBe("สำรองที่ใช้ได้");

    await writeFile(path.join(dataDir, "state.json"), "{corrupt-again", "utf8");
    const recoveredAgain = await new JsonRepository({ dataDir }).init();
    expect(recoveredAgain.snapshot().settings.stationName).toBe("สำรองที่ใช้ได้");
    const backupAfterSecondRecovery = await readFile(path.join(dataDir, "state.json.bak"), "utf8");
    expect(() => JSON.parse(backupAfterSecondRecovery)).not.toThrow();
  });

  it("creates its data directory on first run", async () => {
    const parent = await tempDirectory();
    const nested = path.join(parent, "nested", "data");
    await mkdir(parent, { recursive: true });
    const repository = await new JsonRepository({ dataDir: nested }).init();
    expect(repository.snapshot().schemaVersion).toBe(2);
  });

  it("migrates schema v1 tracks without dropping user data and writes the migration", async () => {
    const dataDir = await tempDirectory();
    await writeFile(path.join(dataDir, "state.json"), JSON.stringify({
      schemaVersion: 1,
      revision: 7,
      settings: {
        stationName: "สถานีเก่า",
        language: "th",
        theme: "dark",
        autoplayNext: true,
        confirmPlayNow: true,
        defaultVolume: 75,
        defaultLyricsMode: "video",
        singleKeyShortcuts: true,
        allowDuplicate: true,
        partyEnabled: false,
        guestRateLimitPerMinute: 10,
        lrclibEnabled: false
      },
      current: {
        id: "11111111-1111-4111-8111-111111111111",
        videoId: "dQw4w9WgXcQ",
        title: "เพลงเก่า",
        channelTitle: "",
        requestedBy: "Host",
        addedAt: new Date(0).toISOString(),
        status: "ready",
        failureReason: null
      },
      queue: [],
      favorites: [],
      history: [],
      lyrics: []
    }), "utf8");

    const repository = await new JsonRepository({ dataDir }).init();
    expect(repository.snapshot()).toMatchObject({
      schemaVersion: 2,
      revision: 7,
      current: {
        title: "เพลงเก่า",
        classification: null,
        badge: null
      }
    });
    const stored = JSON.parse(await readFile(path.join(dataDir, "state.json"), "utf8"));
    expect(stored.schemaVersion).toBe(2);
    expect(stored.current.badge).toBeNull();
  });
});

describe("generatePartyPin", () => {
  it("uses the six-digit PIN range for repeated CSPRNG output", () => {
    const pins = Array.from({ length: 1_000 }, () => generatePartyPin());
    for (const pin of pins) {
      expect(pin).toMatch(/^\d{6}$/);
      expect(Number(pin)).toBeGreaterThanOrEqual(100_000);
      expect(Number(pin)).toBeLessThan(1_000_000);
    }
  });
});
