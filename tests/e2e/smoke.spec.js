import { expect, test } from "@playwright/test";

const partyBase = "http://127.0.0.1:43174";

test("display is clean, creates a fragment-only launch session, and controller joins", async ({ page, request }) => {
  await page.goto("/display?newSession=1");
  await expect(page.getByText("รอเพลงแรก")).toBeVisible();
  await expect(page.getByRole("button", { name: "เปิดการตั้งค่า QR" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "ค้นหาเพลง" })).toHaveCount(0);
  await expect(page.locator(".queue-tab")).toHaveCount(0);

  const session = await request.post("/api/v1/party/session/start", { data: {} });
  expect(session.ok()).toBeTruthy();
  const party = (await session.json()).data;
  expect(party.joinPath).toMatch(/^\/party#join=/);
  expect(party.joinPath).not.toContain("?");

  await page.goto(`${partyBase}${party.joinPath}`);
  await expect(page.getByLabel("ชื่อของคุณ")).toBeVisible();
  await expect(page.getByLabel("รหัส session")).toHaveCount(0);
  await page.getByLabel("ชื่อของคุณ").fill("QA Guest");
  await page.getByRole("button", { name: "เข้าร่วม" }).click();
  await expect(page.getByRole("heading", { name: "ค้นหาเพลง" })).toBeVisible();
  await expect(page).toHaveURL(/\/party$/);

  const token = await page.evaluate(() => sessionStorage.getItem("karaokeLaunchToken"));
  const headers = { Authorization: `Bearer ${token}` };
  const first = { videoId: "dQw4w9WgXcQ", title: "เพลงแรก Karaoke", channelTitle: "QA", classification: "karaoke", badge: "Karaoke" };
  const second = { videoId: "3JZ_D3ELwOQ", title: "เพลงถัดไป Instrumental", channelTitle: "QA", classification: "instrumental", badge: "Instrumental" };
  expect((await request.post(`${partyBase}/api/v1/party/queue`, { headers, data: { track: first } })).ok()).toBeTruthy();
  expect((await request.post(`${partyBase}/api/v1/party/queue`, { headers, data: { track: second } })).ok()).toBeTruthy();
  await expect(page.getByText("เพลงแรก Karaoke")).toBeVisible();
  await page.getByRole("button", { name: /คิว/ }).click();
  await expect(page.getByText("เพลงถัดไป Instrumental")).toBeVisible();
  await page.getByRole("button", { name: "Skip" }).click();
  await expect(page.getByRole("dialog", { name: "ข้ามเพลงนี้?" })).toBeVisible();
  await page.getByRole("button", { name: "ยกเลิก" }).click();
  await expect(page.getByRole("dialog", { name: "ข้ามเพลงนี้?" })).toBeHidden();
});

test("display host settings protects API key input and stays in 360px viewport", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto("/display");
  const opener = page.getByRole("button", { name: "การตั้งค่าสถานี" });
  await opener.click();
  const dialog = page.getByRole("dialog", { name: "การตั้งค่าสถานี" });
  await expect(dialog).toBeVisible();
  const key = page.getByLabel("YouTube API key");
  await expect(key).toHaveAttribute("type", "password");
  await key.fill("AIza-not-a-real-key");
  await page.getByRole("button", { name: "บันทึกการตั้งค่า" }).click();
  await expect(key).toHaveValue("");
  await expect(page.getByText("API key ไม่ถูกแสดงหรือเก็บในเบราว์เซอร์")).toBeVisible();
  const config = (await (await page.request.get("/api/v1/config")).json()).data;
  expect(config.youtube.key).toBeNull();
  await page.getByRole("button", { name: "ลบ YouTube API key" }).click();
  await expect(page.getByText("ลบ YouTube API key ออกจากเครื่องนี้แล้ว")).toBeVisible();
  const layout = await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth && document.documentElement.scrollWidth <= window.innerWidth);
  expect(layout).toBe(true);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();
});

test("TV display keeps its 16:9 stage inside every supported desktop viewport", async ({ page }, testInfo) => {
  for (const viewport of [
    { width: 1366, height: 768 },
    { width: 1680, height: 949 },
    { width: 1920, height: 1080 }
  ]) {
    await page.setViewportSize(viewport);
    await page.goto("/display");
    await expect(page.locator(".tv-video")).toBeVisible();
    const closedFits = await page.evaluate(() => {
      const intersects = (a, b) => a && b && a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
      const qr = document.querySelector(".qr-corner")?.getBoundingClientRect();
      const settings = document.querySelector(".host-settings-button")?.getBoundingClientRect();
      const controls = document.querySelector(".tv-controls")?.getBoundingClientRect();
      const box = document.querySelector(".tv-video").getBoundingClientRect();
      return { scrollWidth: document.documentElement.scrollWidth, scrollHeight: document.documentElement.scrollHeight, innerWidth: window.innerWidth, innerHeight: window.innerHeight, videoAspect: box.width / box.height, qrAvoidsControls: !intersects(qr, controls), floatingSeparate: !intersects(qr, settings) };
    });
    expect(closedFits.scrollWidth).toBeLessThanOrEqual(closedFits.innerWidth);
    expect(closedFits.scrollHeight).toBeLessThanOrEqual(closedFits.innerHeight);
    expect(closedFits.videoAspect).toBeCloseTo(16 / 9, 2);
    expect(closedFits.qrAvoidsControls).toBe(true);
    expect(closedFits.floatingSeparate).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`display-closed-${viewport.width}x${viewport.height}.png`) });

    await page.getByRole("button", { name: "เปิดกล่องเนื้อร้อง" }).click();
    await expect(page.getByRole("complementary", { name: "เนื้อร้อง" })).toBeVisible();
    const openFits = await page.evaluate(() => {
      const intersects = (a, b) => a && b && a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
      const drawer = document.querySelector(".lyrics-bento")?.getBoundingClientRect();
      const header = document.querySelector(".lyrics-bento header")?.getBoundingClientRect();
      const close = document.querySelector(".lyrics-bento .icon-button")?.getBoundingClientRect();
      const qr = document.querySelector(".qr-corner")?.getBoundingClientRect();
      const settings = document.querySelector(".host-settings-button")?.getBoundingClientRect();
      return { scrollWidth: document.documentElement.scrollWidth, scrollHeight: document.documentElement.scrollHeight, innerWidth: window.innerWidth, innerHeight: window.innerHeight, qrAvoidsDrawer: !intersects(qr, drawer) && !intersects(qr, header) && !intersects(qr, close), settingsAvoidsDrawer: !intersects(settings, drawer) && !intersects(settings, header) && !intersects(settings, close), floatingSeparate: !intersects(qr, settings) };
    });
    expect(openFits.scrollWidth).toBeLessThanOrEqual(openFits.innerWidth);
    expect(openFits.scrollHeight).toBeLessThanOrEqual(openFits.innerHeight);
    expect(openFits.qrAvoidsDrawer).toBe(true);
    expect(openFits.settingsAvoidsDrawer).toBe(true);
    expect(openFits.floatingSeparate).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`display-lyrics-${viewport.width}x${viewport.height}.png`) });
  }
});

test("PWA display shell remains available after offline reload", async ({ page }) => {
  await page.goto("/display");
  await page.evaluate(async () => navigator.serviceWorker.ready);
  await page.context().setOffline(true);
  try {
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.locator(".tv-video")).toBeVisible();
  } finally {
    await page.context().setOffline(false);
  }
});
