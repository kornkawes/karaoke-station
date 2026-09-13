// @vitest-environment jsdom
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PreviewYouTubeStage } from "../../src/design-preview/DesignPreviewApp.jsx";

const track = {
  queueId: "queue-1",
  videoId: "dQw4w9WgXcQ",
  title: "เพลงทดสอบ",
  channelTitle: "Karaoke QA"
};

describe("preview host autoplay", () => {
  let calls;

  beforeEach(() => {
    calls = [];
    window.YT = {
      PlayerState: { ENDED: 0, PLAYING: 1 },
      Player: class FakePlayer {
        constructor(_mount, options) {
          this.options = options;
          queueMicrotask(() => options.events.onReady({ target: this }));
        }

        unloadModule(name) { calls.push(["unloadModule", name]); }
        setVolume(value) { calls.push(["setVolume", value]); }
        mute() { calls.push(["mute"]); }
        unMute() { calls.push(["unMute"]); }
        playVideo() {
          calls.push(["playVideo"]);
          this.options.events.onStateChange({ data: window.YT.PlayerState.PLAYING, target: this });
        }
        pauseVideo() { calls.push(["pauseVideo"]); }
        destroy() { calls.push(["destroy"]); }
      }
    };
  });

  afterEach(() => {
    cleanup();
    delete window.YT;
  });

  it("starts muted, then restores room audio after playback begins", async () => {
    render(
      <PreviewYouTubeStage
        track={track}
        playback={{ playing: true, volume: 75, muted: false }}
        onEnded={() => {}}
        onError={() => {}}
      />
    );

    await waitFor(() => expect(calls.some(([name]) => name === "unMute")).toBe(true));

    const muteIndex = calls.findIndex(([name]) => name === "mute");
    const playIndex = calls.findIndex(([name]) => name === "playVideo");
    const unmuteIndex = calls.findIndex(([name]) => name === "unMute");
    expect(muteIndex).toBeGreaterThanOrEqual(0);
    expect(playIndex).toBeGreaterThan(muteIndex);
    expect(unmuteIndex).toBeGreaterThan(playIndex);
  });
});
