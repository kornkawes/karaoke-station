import { expect, test } from "@playwright/test";

/**
 * Layout regression guard.
 *
 * The display is intentionally an edge-to-edge video canvas with glass controls
 * floating above it. These tests assert that the quiet AFTER HOURS HUD stays usable
 * at every target viewport: full-bleed video, QR at lower-left, no overflow.
 */

const VIEWPORTS = [
  { width: 1920, height: 1080, label: "TV 1080p" },
  { width: 1600, height: 900, label: "laptop 16:9" },
  { width: 1366, height: 768, label: "Windows 7 laptop" },
  { width: 1280, height: 800, label: "small laptop" },
  { width: 1152, height: 720, label: "just above breakpoint" },
  { width: 1100, height: 700, label: "at breakpoint" },
  { width: 1024, height: 768, label: "old 4:3" },
  { width: 900, height: 640, label: "narrow window" },
  { width: 800, height: 600, label: "small window" },
  { width: 700, height: 520, label: "tiny window" },
  { width: 1280, height: 430, label: "short and wide" },
  { width: 620, height: 900, label: "narrow and tall" }
];

async function boxes(page) {
  return page.evaluate(() => {
    const rect = (selector) => {
      const element = document.querySelector(selector);
      if (!element) return null;
      const box = element.getBoundingClientRect();
      return {
        x: box.x, y: box.y, width: box.width, height: box.height,
        right: box.right, bottom: box.bottom
      };
    };
    const intersection = (a, b) => {
      if (!a || !b) return 0;
      const w = Math.max(0, Math.min(a.right, b.right) - Math.max(a.x, b.x));
      const h = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y));
      return w * h;
    };
    const video = rect(".hosted-video");
    const side = rect(".hosted-side");
    const topbar = rect(".hosted-topbar");
    const next = rect(".hosted-next");
    const doc = document.documentElement;
    return {
      video,
      side,
      topbar,
      next,
      overlapTopbarSide: intersection(topbar, side),
      horizontalScroll: doc.scrollWidth - doc.clientWidth,
      verticalScroll: doc.scrollHeight - doc.clientHeight,
      viewport: { width: window.innerWidth, height: window.innerHeight }
    };
  });
}

test.describe("hosted display layout", () => {
  test("all target viewports keep the quiet HUD usable", async ({ page }) => {
    await page.setViewportSize(VIEWPORTS[0]);
    await page.goto("/display");
    await expect(page.locator(".hosted-side")).toBeVisible();

    for (const viewport of VIEWPORTS) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await expect(page.locator(".hosted-side")).toBeVisible();
      await expect(page.locator(".hosted-topbar .hosted-meta-text h1")).toBeVisible();
      await expect(page.locator(".hosted-topbar .hosted-meta-text p")).toBeHidden();
      await expect(page.locator(".hosted-topbar .hosted-meta-text span")).toBeHidden();
      await expect(page.locator(".hosted-meta")).toHaveCount(0);

      const layout = await boxes(page);

      // A karaoke display that scrolls is broken; everything must fit.
      expect(layout.horizontalScroll, `${viewport.label} scrolls horizontally`).toBeLessThanOrEqual(1);
      expect(layout.verticalScroll, `${viewport.label} scrolls vertically`).toBeLessThanOrEqual(1);

      // Nothing may hang off the edges of the viewport.
      for (const [name, box] of Object.entries({
        video: layout.video,
        side: layout.side,
        topbar: layout.topbar
      })) {
        expect(box, `${name} is missing`).not.toBeNull();
        expect(box.x, `${name} starts off-screen left`).toBeGreaterThanOrEqual(-1);
        expect(box.y, `${name} starts off-screen top`).toBeGreaterThanOrEqual(-1);
        expect(box.right, `${name} runs off-screen right`).toBeLessThanOrEqual(viewport.width + 1);
        expect(box.bottom, `${name} runs off-screen bottom`).toBeLessThanOrEqual(viewport.height + 1);
      }

      // The video canvas fills the display; YouTube itself letterboxes when needed.
      expect(layout.video.width).toBeGreaterThanOrEqual(viewport.width - 1);
      expect(layout.video.height).toBeGreaterThanOrEqual(viewport.height - 1);

      // AFTER HOURS keeps a compact join card in the lower-left corner.
      expect(layout.side.x, `${viewport.label} QR moved away from lower-left`).toBeLessThanOrEqual(30);
      expect(layout.side.bottom, `${viewport.label} QR is too far above bottom`).toBeGreaterThanOrEqual(viewport.height - 30);

      // The QR has to stay big enough for a phone camera to actually read it.
      const qr = await page.locator(".hosted-side svg").boundingBox();
      expect(qr.width, "QR is too small to scan").toBeGreaterThanOrEqual(60);
    }
  });

  test("QR stays at the lower-left while the video remains full bleed", async ({ page }) => {
    await page.addInitScript(() => {
      let fullscreenTarget = null;
      Object.defineProperty(document, "fullscreenElement", {
        configurable: true,
        get: () => fullscreenTarget
      });
      Element.prototype.requestFullscreen = function requestFullscreen() {
        fullscreenTarget = this;
        document.dispatchEvent(new Event("fullscreenchange"));
        return Promise.resolve();
      };
      document.exitFullscreen = () => {
        fullscreenTarget = null;
        document.dispatchEvent(new Event("fullscreenchange"));
        return Promise.resolve();
      };
    });

    await page.setViewportSize({ width: 1600, height: 900 });
    await page.goto("/display");
    await expect(page.locator(".hosted-side")).toBeVisible();
    const wide = await boxes(page);
    expect(wide.video.width).toBeGreaterThanOrEqual(1599);
    expect(wide.video.height).toBeGreaterThanOrEqual(899);
    expect(wide.side.x).toBeLessThanOrEqual(30);
    expect(wide.side.bottom).toBeGreaterThanOrEqual(870);

    await page.getByRole("button", { name: "ขยายเฉพาะวิดีโอเต็มจอ" }).click();
    await expect(page.getByRole("button", { name: "ย่อหน้าจอเพื่อสแกน QR" })).toBeVisible();
    const fullscreenScope = await page.evaluate(() => ({
      className: document.fullscreenElement?.className,
      containsTopbar: document.fullscreenElement?.contains(document.querySelector(".hosted-topbar")),
      containsQr: document.fullscreenElement?.contains(document.querySelector(".hosted-side"))
    }));
    expect(fullscreenScope).toEqual({
      className: "hosted-video",
      containsTopbar: false,
      containsQr: false
    });
    await page.getByRole("button", { name: "ย่อหน้าจอเพื่อสแกน QR" }).click();
    await expect(page.locator(".hosted-video-exit-fullscreen")).toHaveCount(0);

    await page.setViewportSize({ width: 900, height: 700 });
    await expect(page.locator(".hosted-side")).toBeVisible();
    const narrow = await boxes(page);
    expect(narrow.video.width).toBeGreaterThanOrEqual(899);
    expect(narrow.video.height).toBeGreaterThanOrEqual(699);
    expect(narrow.side.x).toBeLessThanOrEqual(20);
    expect(narrow.side.bottom).toBeGreaterThanOrEqual(680);
  });

  /**
   * Regression: the YouTube API replaces the element it is handed with its own
   * iframe. Passing a React-rendered node made React throw NotFoundError on
   * unmount and blank the entire screen as soon as a track was queued or changed.
   */
  test("mounting and switching tracks never crashes the React tree", async ({ page }) => {
    const errors = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });

    // Deterministic YouTube stand-in: verify the first selected song is asked to
    // play immediately and that the browser-policy fallback can resume with sound.
    await page.addInitScript(() => {
      window.__hostedPlayerCalls = [];
      class FakePlayer {
        constructor(_mount, options) {
          this.options = options;
          this.blockedOnce = false;
          queueMicrotask(() => options.events.onReady({ target: this }));
        }
        setVolume(value) { window.__hostedPlayerCalls.push(["setVolume", value]); }
        playVideo() {
          window.__hostedPlayerCalls.push(["playVideo"]);
          if (!this.blockedOnce) {
            this.blockedOnce = true;
            queueMicrotask(() => this.options.events.onAutoplayBlocked());
          }
        }
        unMute() { window.__hostedPlayerCalls.push(["unMute"]); }
        destroy() {}
      }
      window.YT = { Player: FakePlayer, PlayerState: { ENDED: 0, PLAYING: 1 } };
    });

    await page.setViewportSize({ width: 1366, height: 768 });
    await page.goto("/display");
    await expect(page.locator(".hosted-side")).toBeVisible();

    const session = await page.evaluate(() =>
      JSON.parse(sessionStorage.getItem("karaoke.hostSession"))
    );
    const headers = { Authorization: `Bearer ${session.token}` };
    const queue = `/api/v1/rooms/${session.roomId}/queue`;

    // First track: player mounts for the first time.
    await page.request.post(queue, {
      headers,
      data: { track: { videoId: "dQw4w9WgXcQ", title: "เพลงที่หนึ่ง", channelTitle: "QA" } }
    });
    await expect(page.locator(".hosted-video-mount")).toHaveAttribute("aria-label", "YouTube เพลงที่หนึ่ง");
    await expect.poll(() => page.evaluate(() => window.__hostedPlayerCalls.filter(([name]) => name === "playVideo").length)).toBe(1);
    const unlock = page.getByRole("button", { name: /แตะเพื่อเปิดเสียง/ });
    await expect(unlock).toBeVisible();
    await unlock.click();
    await expect.poll(() => page.evaluate(() => ({
      setVolume: window.__hostedPlayerCalls.some(([name, value]) => name === "setVolume" && value === 75),
      unMute: window.__hostedPlayerCalls.filter(([name]) => name === "unMute").length,
      playVideo: window.__hostedPlayerCalls.filter(([name]) => name === "playVideo").length
    }))).toMatchObject({ setVolume: true, unMute: 2, playVideo: 2 });

    // Second track queued, then advance: the player must tear down and rebuild.
    await page.request.post(queue, {
      headers,
      data: { track: { videoId: "abcdefghijk", title: "เพลงที่สอง", channelTitle: "QA" } }
    });
    await expect(page.locator(".hosted-next")).toContainText("เพลงที่สอง");

    const view = await page.request.get(queue, { headers });
    const revision = (await view.json()).data.revision;
    await page.request.post(`${queue}/advance`, { headers, data: { revision } });

    await expect(page.locator(".hosted-video-mount")).toHaveAttribute("aria-label", "YouTube เพลงที่สอง");

    // The display must still be alive: the QR panel is part of the same tree.
    await expect(page.locator(".hosted-side")).toBeVisible();
    await expect(page.locator(".hosted-video")).toBeVisible();

    const fatal = errors.filter((text) => /NotFoundError|removeChild|Minified React error/i.test(text));
    expect(fatal, `React crashed: ${fatal.join(" | ")}`).toHaveLength(0);
  });

  /**
   * Regression: the display reported a playback failure on ANY player error, so a
   * browser that cannot reach YouTube advanced the queue on every track and drained
   * it. Songs must survive even when the player cannot start.
   */
  test("queued songs survive when the player cannot load", async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 768 });
    await page.goto("/display");
    await expect(page.locator(".hosted-side")).toBeVisible();

    const session = await page.evaluate(() =>
      JSON.parse(sessionStorage.getItem("karaoke.hostSession"))
    );
    const headers = { Authorization: `Bearer ${session.token}` };
    const queue = `/api/v1/rooms/${session.roomId}/queue`;

    await page.request.post(queue, {
      headers,
      data: { track: { videoId: "dQw4w9WgXcQ", title: "เพลงต้องอยู่รอด", channelTitle: "QA" } }
    });
    await page.request.post(queue, {
      headers,
      data: { track: { videoId: "M7lc1UVf-VE", title: "เพลงที่สองต้องอยู่รอด", channelTitle: "QA" } }
    });

    // Give the player time to fail and (incorrectly) drain the queue.
    await page.waitForTimeout(3000);

    const view = await page.request.get(queue, { headers });
    const data = (await view.json()).data;
    expect(data.current, "the current song was discarded").not.toBeNull();
    expect(data.current.title).toBe("เพลงต้องอยู่รอด");
    expect(data.queue, "the waiting queue was drained").toHaveLength(1);

    await expect(page.locator(".hosted-topbar .hosted-meta-text h1")).toHaveText("เพลงต้องอยู่รอด");
    await expect(page.locator(".hosted-topbar .hosted-meta-text h1")).toBeVisible();
    await expect(page.locator(".hosted-next")).toContainText("เพลงที่สองต้องอยู่รอด");
  });

  test("long song titles do not break the layout", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/display");
    await expect(page.locator(".hosted-side")).toBeVisible();

    const session = await page.evaluate(() =>
      JSON.parse(sessionStorage.getItem("karaoke.hostSession"))
    );
    const longTitle = "เพลงคาราโอเกะชื่อยาวมากจนล้นจอ ".repeat(8);
    const response = await page.request.post(`/api/v1/rooms/${session.roomId}/queue`, {
      headers: { Authorization: `Bearer ${session.token}` },
      data: { track: { videoId: "dQw4w9WgXcQ", title: longTitle, channelTitle: "QA" } }
    });
    expect(response.ok()).toBeTruthy();

    await expect(page.locator(".hosted-topbar .hosted-meta-text h1")).toContainText("เพลงคาราโอเกะ");
    await expect(page.locator(".hosted-topbar .hosted-meta-text h1")).toBeVisible();
    const layout = await boxes(page);
    expect(layout.horizontalScroll, "long title caused horizontal scroll").toBeLessThanOrEqual(1);
  });

});
