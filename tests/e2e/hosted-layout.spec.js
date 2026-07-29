import { expect, test } from "@playwright/test";

/**
 * Layout regression guard.
 *
 * The first hosted display floated the QR panel with `position: fixed`, so it sat
 * on top of the video whenever the window was narrow. These tests assert geometry
 * rather than appearance: the QR must never intersect the stage, the video must
 * stay 16:9, and the page must never scroll.
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
    const meta = rect(".hosted-meta");
    const next = rect(".hosted-next");
    const doc = document.documentElement;
    return {
      video,
      side,
      meta,
      next,
      overlapVideoSide: intersection(video, side),
      overlapMetaSide: intersection(meta, side),
      overlapNextSide: intersection(next, side),
      overlapVideoMeta: intersection(video, meta),
      horizontalScroll: doc.scrollWidth - doc.clientWidth,
      verticalScroll: doc.scrollHeight - doc.clientHeight,
      viewport: { width: window.innerWidth, height: window.innerHeight }
    };
  });
}

test.describe("hosted display layout", () => {
  for (const viewport of VIEWPORTS) {
    test(`${viewport.label} (${viewport.width}x${viewport.height}) has no overlap or scroll`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto("/display");
      await expect(page.locator(".hosted-side")).toBeVisible();

      const layout = await boxes(page);

      // The QR panel must never cover the video, the title block, or the next-up pill.
      expect(layout.overlapVideoSide, "QR overlaps the video").toBe(0);
      expect(layout.overlapMetaSide, "QR overlaps the title block").toBe(0);
      expect(layout.overlapNextSide, "QR overlaps the next-up pill").toBe(0);
      expect(layout.overlapVideoMeta, "title block overlaps the video").toBe(0);

      // A karaoke display that scrolls is broken; everything must fit.
      expect(layout.horizontalScroll, "page scrolls horizontally").toBeLessThanOrEqual(1);
      expect(layout.verticalScroll, "page scrolls vertically").toBeLessThanOrEqual(1);

      // Nothing may hang off the edges of the viewport.
      for (const [name, box] of Object.entries({
        video: layout.video,
        side: layout.side,
        meta: layout.meta
      })) {
        expect(box, `${name} is missing`).not.toBeNull();
        expect(box.x, `${name} starts off-screen left`).toBeGreaterThanOrEqual(-1);
        expect(box.y, `${name} starts off-screen top`).toBeGreaterThanOrEqual(-1);
        expect(box.right, `${name} runs off-screen right`).toBeLessThanOrEqual(viewport.width + 1);
        expect(box.bottom, `${name} runs off-screen bottom`).toBeLessThanOrEqual(viewport.height + 1);
      }

      // The video keeps a true 16:9 stage at every size.
      const aspect = layout.video.width / layout.video.height;
      expect(aspect, `aspect ratio drifted: ${aspect.toFixed(3)}`).toBeGreaterThan(1.74);
      expect(aspect, `aspect ratio drifted: ${aspect.toFixed(3)}`).toBeLessThan(1.81);

      // The QR has to stay big enough for a phone camera to actually read it.
      const qr = await page.locator(".hosted-side svg").boundingBox();
      expect(qr.width, "QR is too small to scan").toBeGreaterThanOrEqual(60);
    });
  }

  test("QR sits beside the video on wide screens and below it when narrow", async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 900 });
    await page.goto("/display");
    await expect(page.locator(".hosted-side")).toBeVisible();
    const wide = await boxes(page);
    // Beside: the panel starts to the right of where the video ends.
    expect(wide.side.x).toBeGreaterThanOrEqual(wide.video.right - 1);

    await page.setViewportSize({ width: 900, height: 700 });
    await expect(page.locator(".hosted-side")).toBeVisible();
    const narrow = await boxes(page);
    // Below: the panel starts under the video instead of covering it.
    expect(narrow.side.y).toBeGreaterThanOrEqual(narrow.video.bottom - 1);
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
    await expect(page.locator(".hosted-meta-text h1")).toHaveText("เพลงที่หนึ่ง");

    // Second track queued, then advance: the player must tear down and rebuild.
    await page.request.post(queue, {
      headers,
      data: { track: { videoId: "abcdefghijk", title: "เพลงที่สอง", channelTitle: "QA" } }
    });
    await expect(page.locator(".hosted-next")).toContainText("เพลงที่สอง");

    const view = await page.request.get(queue, { headers });
    const revision = (await view.json()).data.revision;
    await page.request.post(`${queue}/advance`, { headers, data: { revision } });

    await expect(page.locator(".hosted-meta-text h1")).toHaveText("เพลงที่สอง");

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

    await expect(page.locator(".hosted-meta-text h1")).toHaveText("เพลงต้องอยู่รอด");
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

    await expect(page.locator(".hosted-meta-text h1")).toContainText("เพลงคาราโอเกะ");
    const layout = await boxes(page);
    expect(layout.overlapMetaSide, "long title pushed the title block into the QR").toBe(0);
    expect(layout.horizontalScroll, "long title caused horizontal scroll").toBeLessThanOrEqual(1);
  });
});
