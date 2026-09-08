import { expect, test } from "@playwright/test";

const auth = (token) => ({ Authorization: `Bearer ${token}` });

test("approved preview is the default live display and controller", async ({ page, context, request }) => {
  await page.goto("/display");
  await expect(page.locator(".display-stage")).toBeVisible();
  await expect(page.locator(".join-corner")).toBeVisible();
  await expect(page.locator(".next-song")).toContainText("รอเพลงแรก");

  const host = await page.evaluate(() => JSON.parse(sessionStorage.getItem("karaoke.hostSession")));
  expect(host.roomId).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);

  const phone = await context.newPage();
  await phone.setViewportSize({ width: 390, height: 844 });
  await phone.goto(host.joinPath);
  await phone.getByLabel("ชื่อของคุณ").fill("มือถือ Preview");
  await phone.getByRole("button", { name: "เข้าร่วมห้องจริง" }).click();
  await expect(phone.locator(".phone-header .wordmark")).toContainText("KARAOKE STATION");
  await expect(phone.locator(".bottom-nav")).toBeVisible();

  const controller = await phone.evaluate(() => JSON.parse(sessionStorage.getItem("karaoke.controllerSession")));
  const queued = await request.post(`/api/v1/rooms/${host.roomId}/queue`, {
    headers: auth(controller.token),
    data: { track: { videoId: "dQw4w9WgXcQ", title: "เพลงหน้าตา Preview", channelTitle: "QA" } }
  });
  expect(queued.ok()).toBeTruthy();

  await expect(page.locator(".preview-video-layer")).toHaveAttribute("aria-label", "กำลังเล่น เพลงหน้าตา Preview");
  await phone.getByRole("button", { name: /^คิว/ }).click();
  await expect(phone.locator(".queue-title")).toContainText("คิวของเรา");
  await expect(phone.locator(".fair-toggle")).toBeVisible();
  await expect(phone.locator(".now-dock")).toContainText("เพลงหน้าตา Preview");
  await expect(phone.locator(".bottom-nav")).toBeVisible();
});
