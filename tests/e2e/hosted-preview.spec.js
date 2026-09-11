import { expect, test } from "@playwright/test";

const auth = (token) => ({ Authorization: `Bearer ${token}` });

test("approved preview is the default live display and controller", async ({ page, context, request }) => {
  await page.addInitScript(() => localStorage.setItem("karaoke_ui", "modern"));
  // Keep this HUD/layout test deterministic when YouTube changes the sample
  // video's embed policy. The app's loader failure path leaves the queued
  // track visible, which is the state this test exercises.
  await page.route("https://www.youtube.com/**", (route) => route.abort());
  await page.goto("/display");
  await expect(page.locator(".display-stage")).toBeVisible();
  await expect(page.locator('.display-stage[data-display-mode="invite"]')).toBeVisible();
  await expect(page.locator(".invite-gate")).toBeVisible();
  await expect(page.locator(".scan-qr-button")).toContainText("SCAN QR TO JOIN");
  await expect(page.locator(".next-song")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "สร้างห้องใหม่" })).toBeVisible();
  await expect(page.locator(".invite-gate .host-actions button")).toHaveText("สร้างห้องใหม่");
  await expect(page.locator(".invite-gate .host-actions button svg")).toHaveCount(0);
  await expect(page.locator(".invite-brand > span")).toHaveCount(0);
  await expect.poll(() => page.locator(".invite-brand").evaluate((node) => getComputedStyle(node, "::after").display)).toBe("none");
  await expect(page.getByText("พร้อมใช้งาน")).toHaveCount(0);
  await expect(page.locator(".invite-brand strong")).toHaveText("KAVAOKE");
  await expect(page.locator(".invite-room svg")).toHaveCount(1);
  const inviteBrandAboveQr = await page.evaluate(() => {
    const brand = document.querySelector(".invite-brand").getBoundingClientRect();
    const qr = document.querySelector(".invite-gate-qr").getBoundingClientRect();
    return { brandBottom: brand.bottom, qrTop: qr.top };
  });
  expect(inviteBrandAboveQr.brandBottom).toBeLessThanOrEqual(inviteBrandAboveQr.qrTop + 1);
  const inviteIconAlignment = await page.evaluate(() => {
    const icon = document.querySelector(".invite-room .room-icon").getBoundingClientRect();
    const room = document.querySelector(".invite-room strong").getBoundingClientRect();
    return Math.abs((icon.top + icon.height / 2) - (room.top + room.height / 2));
  });
  expect(inviteIconAlignment).toBeLessThanOrEqual(1);
  await expect(page.getByRole("button", { name: "คัดลอกลิงก์" })).toHaveCount(0);
  await expect(page.locator(".join-link")).toHaveCount(0);

  // The shared icon stylesheet must not paint over qrcode.react's dark SVG
  // modules. A visible SVG element alone would miss the blank-cream QR failure.
  const qrPaint = await page.locator(".real-qr svg").evaluate((svg) => {
    const paths = [...svg.querySelectorAll("path")];
    return {
      darkModules: paths.some((path) => getComputedStyle(path).fill === "rgb(5, 6, 7)"),
      strokes: paths.map((path) => getComputedStyle(path).stroke)
    };
  });
  expect(qrPaint.darkModules).toBe(true);
  expect(qrPaint.strokes.every((stroke) => stroke === "none")).toBe(true);

  const host = await page.evaluate(() => JSON.parse(sessionStorage.getItem("karaoke.hostSession")));
  expect(host.roomId).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
  const phone = await context.newPage();
  await phone.setViewportSize({ width: 390, height: 844 });
  await phone.goto(host.joinPath);
  await expect(phone.locator(".phone > .phone-header")).toBeVisible();
  await expect(phone.locator(".sheet-root .remote-sheet")).toBeVisible();
  await expect(phone.locator(".join-sheet .eyebrow")).toHaveCount(0);
  await expect(phone.locator(".join-sheet .sheet-subtitle")).toHaveCount(0);
  await expect(phone.locator("#joinTitle")).toHaveText(host.roomId);
  await phone.getByLabel("ชื่อของคุณ").fill("มือถือ Preview");
  await phone.getByRole("button", { name: "เข้าร่วมห้อง", exact: true }).click();
  await expect(phone.locator(".phone-header .wordmark")).toContainText("KAVAOKE");
  await expect(phone.locator(".phone-header .wordmark i")).toHaveText("STATION");
  await expect(phone.locator(".phone-header .room-icon")).toHaveCount(1);
  await expect(phone.locator(".phone-header .room-icon")).toHaveCSS("width", "14px");
  await expect(phone.locator(".desktop-context")).toHaveCount(0);
  await expect(phone.locator(".search-box input")).toBeEnabled();
  await expect(phone.locator(".mobile-hero")).toHaveCount(0);
  await expect(phone.locator(".mobile-tip")).toContainText("Tips");
  const searchContentOrder = await phone.locator(".phone-content").evaluate((content) => [...content.querySelectorAll(":scope > *")].map((node) => node.className));
  expect(searchContentOrder.indexOf("mobile-tip")).toBeGreaterThan(searchContentOrder.indexOf("chips"));
  await expect(phone.locator(".search-example")).toHaveCount(0);
  await expect(phone.locator(".history-example")).toHaveCount(0);
  await expect(phone.locator(".search-box").locator("button svg")).toBeVisible();
  await expect(phone.locator(".sheet-root .remote-sheet")).toHaveCount(0);
  await expect(phone.locator(".bottom-nav")).toBeVisible();

  // A controller presence switches the Host from the invite lobby to the
  // presentation HUD. The QR leaves the DOM after the first person joins.
  await expect(page.locator('.display-stage[data-display-mode="presentation"]')).toBeVisible();
  await expect(page.locator(".invite-gate")).toHaveCount(0);
  await expect(page.locator(".real-qr")).toHaveCount(0);
  await expect(page.locator(".system-track-bar")).toBeVisible();
  await expect(page.locator(".system-track-kicker-label")).toHaveText("KAVAOKE STATION");

  for (const viewport of [
    { width: 700, height: 520 },
    { width: 520, height: 700 },
    { width: 390, height: 844 }
  ]) {
    await page.setViewportSize(viewport);
    const readyAlignment = await page.evaluate(() => {
      const live = document.querySelector(".system-track-status").getBoundingClientRect();
      const fullscreen = document.querySelector(".display-controls .fullscreen-control").getBoundingClientRect();
      return { liveCenter: live.top + live.height / 2, fullscreenCenter: fullscreen.top + fullscreen.height / 2 };
    });
    expect(Math.abs(readyAlignment.fullscreenCenter - readyAlignment.liveCenter), `${viewport.width}px ready fullscreen alignment`).toBeLessThanOrEqual(1);
  }
  await page.setViewportSize({ width: 1280, height: 720 });

  // The presentation latch survives a Host refresh while the controller socket
  // is reconnecting.
  await page.reload();
  // A cold browser process can re-fetch the lazy preview chunk during reload;
  // wait for that bounded startup without weakening the rest of the flow.
  await expect(page.locator('.display-stage[data-display-mode="presentation"]')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(".invite-gate")).toHaveCount(0);
  // Socket.IO may spend a reconnect backoff window restoring the Host socket
  // after a full refresh. Give the live indicator that bounded reconnect time
  // instead of racing the default five-second assertion timeout.
  await expect(page.locator(".system-track-status.is-online")).toBeVisible({ timeout: 15_000 });

  const controller = await phone.evaluate(() => JSON.parse(sessionStorage.getItem("karaoke.controllerSession")));
  const queued = await request.post(`/api/v1/rooms/${host.roomId}/queue`, {
    headers: auth(controller.token),
    data: { track: { videoId: "dQw4w9WgXcQ", title: "เพลงหน้าตา Preview", channelTitle: "QA" } }
  });
  expect(queued.ok()).toBeTruthy();
  await expect(page.locator(".host-toast.show")).toBeVisible();
  // Read the toast and HUD geometry in one browser-side wait. A later player
  // notice may replace the toast node between two separate locator reads;
  // keeping the condition and snapshot atomic avoids a false layout failure.
  const hostToastMetricsHandle = await page.waitForFunction(() => {
    const toast = document.querySelector(".host-toast.show");
    const metaNode = document.querySelector(".system-track-bar");
    if (!toast || !metaNode) return false;
    const meta = metaNode.getBoundingClientRect();
    const box = toast.getBoundingClientRect();
    const style = getComputedStyle(toast);
    if (box.top < 85 || box.top < meta.bottom - 1) return false;
    return { top: box.top, left: box.left, height: box.height, metaBottom: meta.bottom, whiteSpace: style.whiteSpace };
  });
  const hostToastMetrics = await hostToastMetricsHandle.jsonValue();
  await hostToastMetricsHandle.dispose();
  expect(hostToastMetrics.top).toBeGreaterThanOrEqual(hostToastMetrics.metaBottom - 1);
  expect(hostToastMetrics.left).toBeLessThanOrEqual(40);
  expect(hostToastMetrics.height).toBeLessThanOrEqual(34);
  expect(hostToastMetrics.whiteSpace).toBe("nowrap");
  await page.waitForTimeout(2_100);
  // A player error can legitimately replace the add notice while the test
  // video is initializing. Verify the add toast itself has expired without
  // masking that independent playback status.
  await expect(page.locator(".host-toast").filter({ hasText: "เพิ่ม “เพลงหน้าตา Preview” แล้ว" })).toHaveCount(0);
  const queuedNext = await request.post(`/api/v1/rooms/${host.roomId}/queue`, {
    headers: auth(controller.token),
    data: { track: { videoId: "M7lc1UVf-VE", title: "เพลงถัดไป Preview", channelTitle: "QA" } }
  });
  expect(queuedNext.ok()).toBeTruthy();

  await expect(page.locator(".preview-video-layer")).toHaveAttribute("aria-label", "กำลังเล่น เพลงหน้าตา Preview");
  await expect(page.locator(".system-track-bar")).toContainText("เพลงหน้าตา Preview");
  await expect(page.locator(".system-track-bar")).toContainText("QA");
  await expect(page.locator(".system-track-kicker-label")).toHaveText("NOW PLAYING");
  await expect(page.locator(".up-next-chip p")).toHaveText("UP NEXT");
  await expect(page.locator(".up-next-chip span")).toHaveText("เลือกโดย มือถือ Preview");
  await expect(page.locator(".system-track-source strong")).toHaveText("QA");
  await expect(page.locator(".system-track-roomline")).toContainText(host.roomId);
  await expect(page.locator(".system-track-roomline")).not.toContainText("KAVAOKE");
  await expect(page.locator(".system-track-roomline .room-icon")).toHaveCount(1);
  await expect(page.locator(".system-track-roomline .room-icon")).toHaveCSS("width", "14px");
  const roomlineIconAlignment = await page.evaluate(() => {
    const icon = document.querySelector(".system-track-roomline .room-icon").getBoundingClientRect();
    const room = document.querySelector(".system-track-roomline span").getBoundingClientRect();
    return Math.abs((icon.top + icon.height / 2) - (room.top + room.height / 2));
  });
  expect(roomlineIconAlignment).toBeLessThanOrEqual(1);
  await expect(page.locator(".system-track-status")).toHaveAttribute("aria-label", "LIVE เชื่อมต่อปกติ");
  await expect(page.locator(".system-track-status i")).toBeVisible();
  await expect(page.locator(".system-track-status i")).toHaveCSS("animation-name", "live-status-breathe");
  await expect(page.locator(".system-track-status i")).toHaveCSS("animation-duration", "2.2s");
  await expect(page.locator(".system-track-bar")).toHaveCSS("backdrop-filter", /blur\(30px\)/);
  const fullscreenAlignment = await page.evaluate(() => {
    const bar = document.querySelector(".system-track-bar").getBoundingClientRect();
    const live = document.querySelector(".system-track-status").getBoundingClientRect();
    const fullscreen = document.querySelector(".display-controls .fullscreen-control").getBoundingClientRect();
    return {
      barCenter: bar.top + bar.height / 2,
      liveCenter: live.top + live.height / 2,
      fullscreenCenter: fullscreen.top + fullscreen.height / 2
    };
  });
  expect(Math.abs(fullscreenAlignment.fullscreenCenter - fullscreenAlignment.liveCenter)).toBeLessThanOrEqual(1);
  expect(Math.abs(fullscreenAlignment.fullscreenCenter - fullscreenAlignment.barCenter)).toBeLessThanOrEqual(1);
  const resetIconAlignment = await page.evaluate(() => {
    const button = document.querySelector(".room-reset-control").getBoundingClientRect();
    const icon = document.querySelector(".room-reset-control > svg").getBoundingClientRect();
    return {
      x: Math.abs((button.left + button.width / 2) - (icon.left + icon.width / 2)),
      y: Math.abs((button.top + button.height / 2) - (icon.top + icon.height / 2))
    };
  });
  expect(resetIconAlignment.x).toBeLessThanOrEqual(0.5);
  expect(resetIconAlignment.y).toBeLessThanOrEqual(0.5);
  for (const viewport of [
    { width: 700, height: 520 },
    { width: 520, height: 700 },
    { width: 390, height: 844 }
  ]) {
    await page.setViewportSize(viewport);
    const responsiveAlignment = await page.evaluate(() => {
      const live = document.querySelector(".system-track-status").getBoundingClientRect();
      const fullscreen = document.querySelector(".display-controls .fullscreen-control").getBoundingClientRect();
      return { liveCenter: live.top + live.height / 2, fullscreenCenter: fullscreen.top + fullscreen.height / 2 };
    });
    expect(Math.abs(responsiveAlignment.fullscreenCenter - responsiveAlignment.liveCenter), `${viewport.width}px playing fullscreen alignment`).toBeLessThanOrEqual(1);
  }
  await page.setViewportSize({ width: 1280, height: 720 });
  const hostHud = await page.evaluate(() => {
    const next = document.querySelector(".up-next-chip").getBoundingClientRect();
    const meta = document.querySelector(".system-track-bar").getBoundingClientRect();
    return { next, meta };
  });
  expect(hostHud.next.top).toBeGreaterThanOrEqual(hostHud.meta.top - 1);
  expect(hostHud.next.bottom).toBeLessThanOrEqual(hostHud.meta.bottom + 1);
  expect(hostHud.next.left).toBeGreaterThan(hostHud.meta.left + 20);
  await expect(phone.locator(".now-dock .dock-play")).toHaveAttribute("aria-label", "พักเพลง");
  await phone.getByRole("button", { name: "เปิดรีโมท" }).click();
  await expect(phone.locator(".remote-primary")).toBeVisible();
  await expect(phone.locator(".remote-primary").getByRole("button", { name: "พักเพลง" })).toBeVisible();
  await expect(phone.locator(".remote-primary").getByRole("button", { name: "ข้ามเพลง" })).toBeVisible();
  const remoteColumns = await phone.locator(".remote-primary").evaluate((node) => getComputedStyle(node).gridTemplateColumns.split(" ").filter(Boolean));
  expect(remoteColumns).toHaveLength(2);
  expect(Math.abs(Number.parseFloat(remoteColumns[0]) - Number.parseFloat(remoteColumns[1]))).toBeLessThanOrEqual(1);
  await expect(phone.locator(".remote-primary").getByRole("button", { name: "จบเพลง" })).toHaveCount(0);
  await expect(phone.locator(".remote-sheet")).not.toContainText(host.roomId);
  await expect(phone.locator(".remote-sheet .sheet-note")).toHaveCount(0);
  await phone.locator(".remote-primary").getByRole("button", { name: "ข้ามเพลง" }).click();
  await expect(phone.locator(".now-dock")).toContainText("เพลงถัดไป Preview");
  await expect(phone.locator(".now-dock")).toContainText("Now playing");
  await phone.locator(".bottom-nav button").nth(2).click();
  await expect(phone.locator(".history-title")).toBeVisible();
  await expect(phone.locator(".history-list")).toContainText("เพลงหน้าตา Preview");
  await phone.getByRole("button", { name: /^คิว/ }).click();
  await expect(phone.locator(".queue-title")).toContainText("คิวของเรา");
  await expect(phone.locator(".queue-title .eyebrow")).toHaveCount(0);
  await expect(phone.locator(".queue-toolbar")).toHaveCount(0);
  await expect(phone.locator(".fair-toggle")).toBeVisible();
  await expect(phone.locator(".now-dock")).toContainText("เพลงถัดไป Preview");
  await expect(phone.locator(".bottom-nav")).toBeVisible();

  await expect(page.getByRole("button", { name: "รีเซ็ตห้องกลับไปหน้า QR" })).toBeVisible();
  await page.getByRole("button", { name: "รีเซ็ตห้องกลับไปหน้า QR" }).click();
  await expect(page.locator('.display-stage[data-display-mode="invite"]')).toBeVisible();
  await expect(page.locator(".invite-gate")).toBeVisible();
  const resetHost = await page.evaluate(() => JSON.parse(sessionStorage.getItem("karaoke.hostSession")));
  expect(resetHost.roomId).not.toBe(host.roomId);
});

test("mobile notices stay compact above sheets without horizontal overlap", async ({ page, context, request }) => {
  await page.goto("/display");
  const host = await expect.poll(() => page.evaluate(() => {
    const value = sessionStorage.getItem("karaoke.hostSession");
    return value ? JSON.parse(value) : null;
  })).not.toBeNull().then(() => page.evaluate(() => JSON.parse(sessionStorage.getItem("karaoke.hostSession"))));

  const phone = await context.newPage();
  await phone.setViewportSize({ width: 320, height: 568 });
  await phone.goto(host.joinPath);
  await phone.getByLabel("ชื่อของคุณ").fill("มือถือ Toast");
  await phone.getByRole("button", { name: "เข้าร่วมห้อง", exact: true }).click();
  await expect(phone.locator(".search-box input")).toBeEnabled();

  const controller = await phone.evaluate(() => JSON.parse(sessionStorage.getItem("karaoke.controllerSession")));
  const first = await request.post(`/api/v1/rooms/${host.roomId}/queue`, {
    headers: auth(controller.token),
    data: { track: { videoId: "dQw4w9WgXcQ", title: "Toast เพลงหลัก", channelTitle: "QA" } }
  });
  const second = await request.post(`/api/v1/rooms/${host.roomId}/queue`, {
    headers: auth(controller.token),
    data: { track: { videoId: "M7lc1UVf-VE", title: "Toast เพลงถัดไป", channelTitle: "QA" } }
  });
  expect(first.ok()).toBeTruthy();
  expect(second.ok()).toBeTruthy();

  await phone.getByRole("button", { name: /^คิว/ }).click();
  await expect(phone.locator(".queue-item")).toHaveCount(1);
  await expect(phone.locator(".queue-toolbar")).toHaveCount(0);
  await expect(phone.locator(".queue-drag-handle")).toHaveCount(1);
  const queueCoverSize = await phone.locator(".queue-item .real-cover").evaluate((node) => node.getBoundingClientRect().width);
  expect(queueCoverSize).toBeGreaterThanOrEqual(56);
  await expect(phone.locator(".queue-title-marquee")).toBeVisible();
  const queueGeometry = await phone.evaluate(() => [...document.querySelectorAll(".queue-item")].map((row) => {
    const cover = row.querySelector(".real-cover").getBoundingClientRect();
    const content = row.querySelector(":scope > div:last-child").getBoundingClientRect();
    const controls = row.querySelector(".queue-controls").getBoundingClientRect();
    return { coverRight: cover.right, contentLeft: content.left, controlsRight: controls.right, rowRight: row.getBoundingClientRect().right };
  }));
  expect(queueGeometry.length).toBeGreaterThan(0);
  for (const metrics of queueGeometry) {
    expect(metrics.coverRight).toBeLessThanOrEqual(metrics.contentLeft + 1);
    expect(metrics.controlsRight).toBeLessThanOrEqual(metrics.rowRight + 1);
  }
  await phone.getByRole("button", { name: "ลบเพลง" }).click();
  await expect(phone.locator(".toast.show")).toBeVisible();
  const metrics = await phone.evaluate(() => {
    const toast = document.querySelector(".toast.show").getBoundingClientRect();
    const style = getComputedStyle(document.querySelector(".toast.show"));
    return {
      top: toast.top,
      width: toast.width,
      height: toast.height,
      zIndex: Number(style.zIndex),
      centerDelta: Math.abs((toast.left + toast.width / 2) - window.innerWidth / 2),
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth
    };
  });
  expect(metrics.top).toBeGreaterThanOrEqual(80);
  expect(metrics.top).toBeLessThan(90);
  expect(metrics.width).toBeLessThanOrEqual(296);
  expect(metrics.height).toBeLessThanOrEqual(64);
  expect(metrics.centerDelta).toBeLessThanOrEqual(1);
  expect(metrics.zIndex).toBeGreaterThan(52);
  expect(metrics.overflow).toBeLessThanOrEqual(1);

  await phone.getByRole("button", { name: "เปิดรีโมท" }).click();
  await expect(phone.locator(".remote-sheet")).toBeVisible();
  if (await phone.locator(".toast.show").count()) {
    const sheetToastMetrics = await phone.evaluate(() => {
      const toast = document.querySelector(".toast.show").getBoundingClientRect();
      const sheet = document.querySelector(".remote-sheet").getBoundingClientRect();
      return { toastBottom: toast.bottom, sheetTop: sheet.top };
    });
    expect(sheetToastMetrics.toastBottom).toBeLessThan(120);
    expect(sheetToastMetrics.toastBottom).toBeLessThanOrEqual(sheetToastMetrics.sheetTop + 1);
  }
  await phone.waitForTimeout(2_100);
  await expect(phone.locator(".toast")).toHaveCount(0);
});

test("search loads one 15-song page and one more page at the list end", async ({ page, context }) => {
  await page.goto("/display");
  const host = await expect.poll(() => page.evaluate(() => {
    const value = sessionStorage.getItem("karaoke.hostSession");
    return value ? JSON.parse(value) : null;
  })).not.toBeNull().then(() => page.evaluate(() => JSON.parse(sessionStorage.getItem("karaoke.hostSession"))));

  const phone = await context.newPage();
  await phone.setViewportSize({ width: 390, height: 844 });
  const requests = [];
  await phone.route("**/api/v1/rooms/*/search*", async (route) => {
    const url = new URL(route.request().url());
    requests.push(url);
    const pageNumber = url.searchParams.has("pageToken") ? 2 : 1;
    const start = pageNumber === 1 ? 0 : 15;
    const results = Array.from({ length: 15 }, (_, index) => ({
      videoId: `${"a".repeat(10)}${(start + index).toString(36)}`,
      title: `เพลงหน้า ${start + index + 1} Karaoke`,
      channelTitle: "QA Karaoke",
      classification: "karaoke",
      badge: "Karaoke"
    }));
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: { results, nextPageToken: pageNumber === 1 ? "PAGE_TWO" : "PAGE_THREE" } })
    });
  });

  await phone.goto(host.joinPath);
  await phone.getByLabel("ชื่อของคุณ").fill("มือถือ Pagination");
  await phone.getByRole("button", { name: "เข้าร่วมห้อง", exact: true }).click();
  await expect(phone.locator(".search-box input")).toBeEnabled();
  await phone.locator(".search-box input").fill("เพลงทดสอบ");
  await phone.locator(".search-box button").click();
  await expect(phone.locator(".song-row")).toHaveCount(15);
  await expect.poll(() => requests.length).toBe(1);
  expect(requests[0].searchParams.get("limit")).toBe("15");
  expect(requests[0].searchParams.has("pageToken")).toBe(false);

  await phone.locator(".phone-content").evaluate((node) => node.scrollTo(0, node.scrollHeight));
  await expect.poll(() => requests.length).toBe(2);
  await expect(phone.locator(".song-row")).toHaveCount(30);
  expect(requests[1].searchParams.get("limit")).toBe("15");
  expect(requests[1].searchParams.get("pageToken")).toBe("PAGE_TWO");
  await expect(phone.locator(".search-load-more")).toHaveCount(0);
});

test("mobile shell keeps header, scroll area, dock and nav in separate layers", async ({ page, context }) => {
  await page.goto("/display");
  const host = await expect.poll(() => page.evaluate(() => {
    const value = sessionStorage.getItem("karaoke.hostSession");
    return value ? JSON.parse(value) : null;
  })).not.toBeNull().then(() => page.evaluate(() => JSON.parse(sessionStorage.getItem("karaoke.hostSession"))));

  const phone = await context.newPage();
  await phone.goto(host.joinPath);
  await phone.getByLabel("ชื่อของคุณ").fill("มือถือ Layout");
  await phone.getByRole("button", { name: "เข้าร่วมห้อง", exact: true }).click();
  await expect(phone.locator(".search-box input")).toBeEnabled();
  await phone.getByRole("button", { name: "ประวัติ" }).click();
  await expect(phone.locator(".history-title")).toBeVisible();
  await expect(phone.locator(".history-example")).toHaveCount(0);
  await expect(phone.locator(".history-list .empty-state")).toContainText("ยังไม่มีประวัติการร้อง");
  await expect(phone.locator(".history-title .room-icon")).toHaveCount(0);
  await expect(phone.locator(".phone-header .wordmark")).toContainText("KAVAOKE");
  await phone.locator(".bottom-nav button").first().click();

  for (const viewport of [
    { width: 320, height: 568 },
    { width: 360, height: 740 },
    { width: 390, height: 844 },
    { width: 412, height: 915 },
    { width: 768, height: 1024 },
    { width: 1024, height: 768 },
    { width: 844, height: 390 }
  ]) {
    await phone.setViewportSize(viewport);
    const layout = await phone.evaluate(() => {
      const box = (selector) => document.querySelector(selector)?.getBoundingClientRect().toJSON() || null;
      const phoneBox = box(".phone");
      const header = box(".phone-header");
      const content = box(".phone-content");
      const dock = box(".now-dock");
      const nav = box(".bottom-nav");
      return {
        phone: phoneBox,
        header,
        content,
        dock,
        nav,
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        verticalOverflow: document.documentElement.scrollHeight - document.documentElement.clientHeight
      };
    });
    expect(layout.phone.right, `${viewport.width} phone right edge`).toBeLessThanOrEqual(viewport.width + 1);
    expect(layout.phone.bottom, `${viewport.height} phone bottom edge`).toBeLessThanOrEqual(viewport.height + 1);
    expect(layout.header.bottom).toBeLessThanOrEqual(layout.content.top + 1);
    expect(layout.content.bottom).toBeLessThanOrEqual(layout.dock.top + 1);
    expect(layout.dock.bottom).toBeLessThanOrEqual(layout.nav.top + 1);
    expect(layout.nav.bottom).toBeLessThanOrEqual(layout.phone.bottom + 1);
    expect(layout.overflow, `${viewport.width} horizontal overflow`).toBeLessThanOrEqual(1);
    expect(layout.verticalOverflow, `${viewport.height} vertical overflow`).toBeLessThanOrEqual(1);
  }
});
