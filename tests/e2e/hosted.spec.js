import { expect, test } from "@playwright/test";

/**
 * Full hosted flow against the real built app:
 * display creates a room -> QR encodes the join URL -> phone joins -> adds a song ->
 * the display sees it in realtime.
 */
test("display opens a room and a phone joins and queues a song", async ({ page, context, request }) => {
  await page.goto("/display");

  // The display provisions its own room with no interaction.
  await expect(page.getByRole("heading", { name: "รอเพลงแรก", level: 2 })).toBeVisible();
  await expect(page.getByText(/^ห้อง /)).toBeVisible();

  const hostSession = await page.evaluate(() => JSON.parse(sessionStorage.getItem("karaoke.hostSession")));
  expect(hostSession.roomId).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
  expect(hostSession.joinPath).toMatch(/^\/party#room=/);
  // The join token must ride in the fragment, never the query string.
  expect(hostSession.joinPath.split("#")[0]).toBe("/party");

  // A phone scans the QR and lands on the join screen.
  const phone = await context.newPage();
  await phone.goto(hostSession.joinPath);
  await expect(phone.getByLabel("ชื่อของคุณ")).toBeVisible();
  await phone.getByLabel("ชื่อของคุณ").fill("มือถือ QA");
  await phone.getByRole("button", { name: "เข้าร่วม" }).click();
  await expect(phone.getByRole("heading", { name: "ค้นหาเพลง" })).toBeVisible();

  // The fragment is stripped once consumed, so the token cannot be re-shared.
  await expect(phone).toHaveURL(/\/party$/);

  const controller = await phone.evaluate(() =>
    JSON.parse(sessionStorage.getItem("karaoke.controllerSession"))
  );
  expect(controller.roomId).toBe(hostSession.roomId);
  expect(controller.token).not.toBe(hostSession.token);

  // Queue a track through the controller's own credentials.
  const added = await request.post(`/api/v1/rooms/${hostSession.roomId}/queue`, {
    headers: { Authorization: `Bearer ${controller.token}` },
    data: {
      track: {
        videoId: "dQw4w9WgXcQ",
        title: "เพลงทดสอบ Karaoke",
        channelTitle: "QA",
        classification: "karaoke",
        badge: "Karaoke"
      }
    }
  });
  expect(added.ok()).toBeTruthy();

  // The display receives it over the socket without a reload.
  await expect(page.getByRole("heading", { name: "เพลงทดสอบ Karaoke" })).toBeVisible({ timeout: 10_000 });

  // And the phone's queue tab reflects the same shared state.
  await phone.getByRole("button", { name: /คิว/ }).click();
  await expect(phone.getByText("เพลงทดสอบ Karaoke")).toBeVisible();
});

test("a controller cannot reach another room", async ({ page, context, request }) => {
  await page.goto("/display");
  await expect(page.getByText(/^ห้อง /)).toBeVisible();
  const roomA = await page.evaluate(() => JSON.parse(sessionStorage.getItem("karaoke.hostSession")));

  const phone = await context.newPage();
  await phone.goto(roomA.joinPath);
  await phone.getByLabel("ชื่อของคุณ").fill("ผู้ทดสอบ");
  await phone.getByRole("button", { name: "เข้าร่วม" }).click();
  await expect(phone.getByRole("heading", { name: "ค้นหาเพลง" })).toBeVisible();
  const controllerA = await phone.evaluate(() =>
    JSON.parse(sessionStorage.getItem("karaoke.controllerSession"))
  );

  // A second, unrelated room.
  const createdB = await request.post("/api/v1/rooms", { data: {} });
  const roomB = (await createdB.json()).data;

  const crossRead = await request.get(`/api/v1/rooms/${roomB.roomId}/queue`, {
    headers: { Authorization: `Bearer ${controllerA.token}` }
  });
  expect(crossRead.status()).toBe(401);

  const crossWrite = await request.post(`/api/v1/rooms/${roomB.roomId}/queue`, {
    headers: { Authorization: `Bearer ${controllerA.token}` },
    data: { track: { videoId: "dQw4w9WgXcQ", title: "ห้ามเข้า" } }
  });
  expect(crossWrite.status()).toBe(401);
});

test("api responses are no-store and never expose the key", async ({ request }) => {
  const created = await request.post("/api/v1/rooms", { data: {} });
  expect(created.headers()["cache-control"]).toBe("no-store, max-age=0");

  const room = (await created.json()).data;
  const health = await request.get("/api/v1/health");
  const body = await health.text();
  expect(body).not.toMatch(/AIza[0-9A-Za-z_-]{20,}/);

  const view = await request.get(`/api/v1/rooms/${room.roomId}`, {
    headers: { Authorization: `Bearer ${room.hostToken}` }
  });
  expect(await view.text()).not.toMatch(/AIza[0-9A-Za-z_-]{20,}/);
});
