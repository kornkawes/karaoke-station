import { expect, test } from "@playwright/test";

const auth = (token) => ({ Authorization: `Bearer ${token}` });
const hostedPath = (joinPath) => joinPath.replace("/party#", "/party?ui=hosted#");

async function installFakeYouTube(page) {
  await page.addInitScript(() => {
    window.__afterHoursPlayerCalls = [];
    class FakePlayer {
      constructor(_mount, options) {
        this.options = options;
        queueMicrotask(() => options.events.onReady({ target: this }));
      }
      setVolume(value) { window.__afterHoursPlayerCalls.push(["setVolume", value]); }
      mute() { window.__afterHoursPlayerCalls.push(["mute"]); }
      unMute() { window.__afterHoursPlayerCalls.push(["unMute"]); }
      playVideo() { window.__afterHoursPlayerCalls.push(["playVideo"]); }
      pauseVideo() { window.__afterHoursPlayerCalls.push(["pauseVideo"]); }
      destroy() { window.__afterHoursPlayerCalls.push(["destroy"]); }
    }
    window.YT = { Player: FakePlayer, PlayerState: { ENDED: 0, PLAYING: 1 } };
  });
}

async function openPairedRoom(page, context, phoneWidth = 390) {
  await installFakeYouTube(page);
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto("/display?ui=hosted");
  const host = await expect.poll(() => page.evaluate(() => {
    const value = sessionStorage.getItem("karaoke.hostSession");
    return value ? JSON.parse(value) : null;
  })).not.toBeNull().then(() => page.evaluate(() =>
    JSON.parse(sessionStorage.getItem("karaoke.hostSession"))
  ));

  const phone = await context.newPage();
  await phone.setViewportSize({ width: phoneWidth, height: 844 });
  await phone.goto(hostedPath(host.joinPath));
  await phone.getByLabel("ชื่อของคุณ").fill("มือถือ QA");
  await phone.getByRole("button", { name: "เข้าร่วม" }).click();
  await expect(phone.getByRole("heading", { name: "ค้นหาเพลง" })).toBeVisible();
  const controller = await phone.evaluate(() =>
    JSON.parse(sessionStorage.getItem("karaoke.controllerSession"))
  );
  return { host, phone, controller };
}

async function addTrack(request, roomId, token, title, videoId = "dQw4w9WgXcQ") {
  const response = await request.post(`/api/v1/rooms/${roomId}/queue`, {
    headers: auth(token),
    data: { track: { videoId, title, channelTitle: "QA" } }
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  return (await response.json()).data;
}

async function roomView(request, roomId, token) {
  const response = await request.get(`/api/v1/rooms/${roomId}/queue`, {
    headers: auth(token)
  });
  expect(response.ok()).toBeTruthy();
  return (await response.json()).data;
}

test("phone playback controls update the real room and paired display", async ({ page, context, request }) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  const { host, phone, controller } = await openPairedRoom(page, context);
  await addTrack(request, host.roomId, controller.token, "เพลงหลัก", "main0000001");
  await addTrack(request, host.roomId, controller.token, "เพลงถัดไป", "next0000001");

  await expect(page.locator(".hosted-video-mount")).toHaveAttribute("aria-label", "YouTube เพลงหลัก");
  await expect(phone.locator(".remote-now-playing strong")).toHaveText("เพลงหลัก");

  await phone.getByRole("button", { name: "พักเพลง" }).click();
  await expect.poll(async () => (await roomView(request, host.roomId, controller.token)).playback.playing).toBe(false);
  await expect.poll(() => page.evaluate(() =>
    window.__afterHoursPlayerCalls.filter(([name]) => name === "pauseVideo").length
  )).toBeGreaterThan(0);

  await expect(phone.getByRole("button", { name: "เล่นเพลงต่อ" })).toBeEnabled();
  await phone.getByRole("button", { name: "เล่นเพลงต่อ" }).click();
  await expect.poll(async () => (await roomView(request, host.roomId, controller.token)).playback.playing).toBe(true);
  await expect.poll(() => page.evaluate(() =>
    window.__afterHoursPlayerCalls.filter(([name]) => name === "playVideo").length
  )).toBeGreaterThan(1);

  await phone.getByLabel("ระดับเสียง").fill("33");
  await expect.poll(async () => (await roomView(request, host.roomId, controller.token)).playback.volume).toBe(33);
  await expect.poll(() => page.evaluate(() =>
    window.__afterHoursPlayerCalls.some(([name, value]) => name === "setVolume" && value === 33)
  )).toBe(true);

  await expect(phone.getByRole("button", { name: "ปิดเสียง" })).toBeEnabled();
  await phone.getByRole("button", { name: "ปิดเสียง" }).click();
  await expect.poll(async () => (await roomView(request, host.roomId, controller.token)).playback.muted).toBe(true);
  await expect.poll(() => page.evaluate(() =>
    window.__afterHoursPlayerCalls.some(([name]) => name === "mute")
  )).toBe(true);

  await expect(phone.getByRole("button", { name: "ข้ามเพลง" })).toBeEnabled();
  await phone.getByRole("button", { name: "ข้ามเพลง" }).click();
  await expect(phone.locator(".remote-now-playing strong")).toHaveText("เพลงถัดไป");
  await expect(page.locator(".hosted-video-mount")).toHaveAttribute("aria-label", "YouTube เพลงถัดไป");

  const historyResponse = await request.get(`/api/v1/rooms/${host.roomId}/history`, {
    headers: auth(controller.token)
  });
  const history = (await historyResponse.json()).data.history;
  expect(history[0]).toMatchObject({ title: "เพลงหลัก", status: "skipped" });

  const invalidVolume = await request.patch(`/api/v1/rooms/${host.roomId}/playback`, {
    headers: auth(controller.token), data: { volume: 101 }
  });
  expect(invalidVolume.status()).toBe(400);
  const emptyPatch = await request.patch(`/api/v1/rooms/${host.roomId}/playback`, {
    headers: auth(controller.token), data: {}
  });
  expect(emptyPatch.status()).toBe(400);
  expect(errors).toEqual([]);
});

test("compact fair control and duplicate queue items remain operable at 390 and 320", async ({ page, context, request }) => {
  const { host, phone, controller } = await openPairedRoom(page, context);

  for (const width of [390, 320]) {
    await phone.setViewportSize({ width, height: 844 });
    const metrics = await phone.locator(".fair-queue-control").evaluate((button) => {
      const track = button.querySelector("i");
      const buttonBox = button.getBoundingClientRect();
      const trackBox = track.getBoundingClientRect();
      return {
        button: { width: buttonBox.width, height: buttonBox.height },
        track: { width: trackBox.width, height: trackBox.height },
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth
      };
    });
    expect(metrics.button.width, `${width}px fair hit width`).toBeGreaterThanOrEqual(44);
    expect(metrics.button.height, `${width}px fair hit height`).toBeGreaterThanOrEqual(44);
    expect(metrics.track).toEqual({ width: 36, height: 22 });
    expect(metrics.overflow, `${width}px horizontal overflow`).toBeLessThanOrEqual(1);
  }

  await phone.setViewportSize({ width: 390, height: 844 });
  const fairButton = phone.getByRole("button", { name: "เปิดคิวผลัดกันร้อง" });
  await fairButton.click();
  await expect(phone.getByRole("button", { name: "คิวผลัดกันร้อง: เปิด" })).toHaveAttribute("aria-pressed", "true");
  await expect.poll(async () => (await roomView(request, host.roomId, controller.token)).settings.fairQueue).toBe(true);

  await addTrack(request, host.roomId, controller.token, "เพลงต้นฉบับ", "original001");
  const repeated = [];
  for (const title of ["เพลงซ้ำ A", "เพลงซ้ำ B", "เพลงซ้ำ C"]) {
    repeated.push(await addTrack(request, host.roomId, controller.token, title, "repeat00001"));
  }
  expect(new Set(repeated.map(({ item }) => item.id)).size).toBe(3);

  await phone.getByRole("button", { name: /^คิว(?: \(\d+\))?$/ }).click();
  const queueTitles = phone.locator(".queue-tab ol li strong");
  await expect(queueTitles).toHaveText(["เพลงซ้ำ A", "เพลงซ้ำ B", "เพลงซ้ำ C"]);

  await phone.getByRole("button", { name: "เล่น เพลงซ้ำ B ทันที" }).click();
  await expect(phone.locator(".remote-now-playing strong")).toHaveText("เพลงซ้ำ B");
  await expect(queueTitles).toHaveText(["เพลงซ้ำ A", "เพลงซ้ำ C"]);
  let view = await roomView(request, host.roomId, controller.token);
  expect(view.current.title).toBe("เพลงซ้ำ B");
  expect(view.queue.map(({ title }) => title)).toEqual(["เพลงซ้ำ A", "เพลงซ้ำ C"]);

  const historyResponse = await request.get(`/api/v1/rooms/${host.roomId}/history`, {
    headers: auth(controller.token)
  });
  const history = (await historyResponse.json()).data.history;
  expect(history[0]).toMatchObject({ title: "เพลงต้นฉบับ", status: "interrupted" });

  await phone.getByRole("button", { name: "ลบ เพลงซ้ำ A" }).click();
  await expect(queueTitles).toHaveText(["เพลงซ้ำ C"]);
  await addTrack(request, host.roomId, controller.token, "เพลงซ้ำ D", "repeat00001");
  await expect(queueTitles).toHaveText(["เพลงซ้ำ C", "เพลงซ้ำ D"]);
  await phone.getByRole("button", { name: "สลับคิว" }).click();
  await phone.getByRole("button", { name: "ย้าย เพลงซ้ำ D ขึ้น" }).click();
  await expect(queueTitles).toHaveText(["เพลงซ้ำ D", "เพลงซ้ำ C"]);
  view = await roomView(request, host.roomId, controller.token);
  expect(view.queue.map(({ title }) => title)).toEqual(["เพลงซ้ำ D", "เพลงซ้ำ C"]);

  await phone.getByRole("button", { name: "เสร็จสิ้น" }).click();
  const phoneToastClose = phone.getByRole("button", { name: "ปิดข้อความ" });
  if (await phoneToastClose.isVisible()) await phoneToastClose.click();
  const hostToastClose = page.getByRole("button", { name: "ปิดข้อความ" });
  if (await hostToastClose.isVisible()) await hostToastClose.click();
  await phone.screenshot({ path: "test-results/qa-mobile-390.png", fullPage: false });
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.screenshot({ path: "test-results/qa-host-1366.png", fullPage: false });
  const hostLayout = await page.evaluate(() => ({
    horizontal: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    vertical: document.documentElement.scrollHeight - document.documentElement.clientHeight,
    headerDisplay: getComputedStyle(document.querySelector(".hosted-meta-text")).display,
    video: document.querySelector(".hosted-video").getBoundingClientRect().toJSON()
  }));
  expect(hostLayout.horizontal).toBeLessThanOrEqual(1);
  expect(hostLayout.vertical).toBeLessThanOrEqual(1);
  expect(hostLayout.headerDisplay).toBe("block");
  expect(hostLayout.video.width).toBeGreaterThanOrEqual(1365);
  expect(hostLayout.video.height).toBeGreaterThanOrEqual(767);
});
