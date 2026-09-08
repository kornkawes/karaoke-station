import { expect, test } from "@playwright/test";

const auth = (token) => ({ Authorization: `Bearer ${token}` });

test("approved preview is the default live display and controller", async ({ page, context, request }) => {
  await page.addInitScript(() => localStorage.setItem("karaoke_ui", "modern"));
  await page.goto("/display");
  await expect(page.locator(".display-stage")).toBeVisible();
  await expect(page.locator(".join-corner")).toBeVisible();
  await expect(page.locator(".next-song")).toContainText("รอเพลงแรก");

  const host = await page.evaluate(() => JSON.parse(sessionStorage.getItem("karaoke.hostSession")));
  expect(host.roomId).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);

  const phone = await context.newPage();
  await phone.setViewportSize({ width: 390, height: 844 });
  await phone.goto(host.joinPath);
  await expect(phone.locator(".phone > .phone-header")).toBeVisible();
  await expect(phone.locator(".sheet-root .remote-sheet")).toBeVisible();
  await phone.getByLabel("ชื่อของคุณ").fill("มือถือ Preview");
  await phone.getByRole("button", { name: "เข้าร่วมห้องจริง" }).click();
  await expect(phone.locator(".phone-header .wordmark")).toContainText("KARAOKE STATION");
  await expect(phone.locator(".search-box input")).toBeEnabled();
  await expect(phone.locator(".sheet-root .remote-sheet")).toHaveCount(0);
  await expect(phone.locator(".bottom-nav")).toBeVisible();

  const controller = await phone.evaluate(() => JSON.parse(sessionStorage.getItem("karaoke.controllerSession")));
  const queued = await request.post(`/api/v1/rooms/${host.roomId}/queue`, {
    headers: auth(controller.token),
    data: { track: { videoId: "dQw4w9WgXcQ", title: "เพลงหน้าตา Preview", channelTitle: "QA" } }
  });
  expect(queued.ok()).toBeTruthy();
  const queuedNext = await request.post(`/api/v1/rooms/${host.roomId}/queue`, {
    headers: auth(controller.token),
    data: { track: { videoId: "M7lc1UVf-VE", title: "เพลงถัดไป Preview", channelTitle: "QA" } }
  });
  expect(queuedNext.ok()).toBeTruthy();

  await expect(page.locator(".preview-video-layer")).toHaveAttribute("aria-label", "กำลังเล่น เพลงหน้าตา Preview");
  await expect(phone.locator(".now-dock .dock-play")).toHaveAttribute("aria-label", "พักเพลง");
  await phone.getByRole("button", { name: "เปิดรีโมท" }).click();
  await expect(phone.locator(".remote-primary")).toBeVisible();
  await expect(phone.locator(".remote-primary").getByRole("button", { name: "พักเพลง" })).toBeVisible();
  await expect(phone.locator(".remote-primary").getByRole("button", { name: "ข้ามเพลง" })).toBeVisible();
  await expect(phone.locator(".remote-primary").getByRole("button", { name: "จบเพลง" })).toBeVisible();
  await phone.locator(".remote-primary").getByRole("button", { name: "จบเพลง" }).click();
  await expect(phone.locator(".now-dock")).toContainText("เพลงถัดไป Preview");
  await phone.locator(".sheet-close").click();
  await phone.getByRole("button", { name: /^คิว/ }).click();
  await expect(phone.locator(".queue-title")).toContainText("คิวของเรา");
  await expect(phone.locator(".fair-toggle")).toBeVisible();
  await expect(phone.locator(".now-dock")).toContainText("เพลงถัดไป Preview");
  await expect(phone.locator(".bottom-nav")).toBeVisible();
});
