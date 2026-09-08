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

  // Queue mode is a phone/controller action; the TV display must not expose it.
  await expect(page.getByRole("button", { name: /คิวผลัดกันร้อง/ })).toHaveCount(0);

  // A phone scans the QR and lands on the join screen.
  const phone = await context.newPage();
  await phone.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, "share", {
      configurable: true,
      value: async (payload) => { window.__sharedRoom = payload; }
    });
  });
  await phone.goto(hostSession.joinPath);
  await expect(phone.getByLabel("ชื่อของคุณ")).toBeVisible();
  await phone.getByLabel("ชื่อของคุณ").fill("มือถือ QA");
  await phone.getByRole("button", { name: "เข้าร่วม" }).click();
  await expect(phone.getByRole("heading", { name: "ค้นหาเพลง" })).toBeVisible();

  // The fragment is stripped once consumed, so the token cannot be re-shared.
  await expect(phone).toHaveURL(/\/party$/);

  const phoneFairQueueButton = phone.getByRole("button", { name: "เปิดคิวผลัดกันร้อง" });
  await expect(phoneFairQueueButton).toBeVisible();
  await phoneFairQueueButton.click();
  await expect(phone.getByRole("button", { name: "คิวผลัดกันร้อง: เปิด" }))
    .toHaveAttribute("aria-pressed", "true");
  const hostViewAfterToggle = await request.get(`/api/v1/rooms/${hostSession.roomId}`, {
    headers: { Authorization: `Bearer ${hostSession.token}` }
  });
  expect((await hostViewAfterToggle.json()).data.settings.fairQueue).toBe(true);

  const controller = await phone.evaluate(() =>
    JSON.parse(sessionStorage.getItem("karaoke.controllerSession"))
  );
  expect(controller.roomId).toBe(hostSession.roomId);
  expect(controller.token).not.toBe(hostSession.token);
  expect(controller.joinToken).toBe(decodeURIComponent(hostSession.joinPath.split("&join=")[1]));

  await phone.getByRole("button", { name: "แชร์ลิงก์ห้องเข้า LINE หรือส่งให้เพื่อน" }).click();
  const shared = await phone.evaluate(() => window.__sharedRoom);
  expect(shared.url).toContain(`#room=${hostSession.roomId}&join=`);
  expect(shared.url).toContain(controller.joinToken);

  // The alternate modern mobile UI uses the same controller session and must
  // keep the toggle on the phone as well.
  const modernPhone = await context.newPage();
  await modernPhone.addInitScript((storedSession) => {
    sessionStorage.setItem("karaoke.controllerSession", JSON.stringify(storedSession));
  }, controller);
  await modernPhone.goto("/party?ui=modern");
  await expect(modernPhone.getByRole("button", { name: "คิวผลัดกันร้อง: เปิด" })).toBeVisible();
  await modernPhone.getByRole("button", { name: "คิวผลัดกันร้อง: เปิด" }).click();
  await expect(modernPhone.getByRole("button", { name: "เปิดคิวผลัดกันร้อง" }))
    .toHaveAttribute("aria-pressed", "false");
  await modernPhone.getByRole("button", { name: "เปิดคิวผลัดกันร้อง" }).click();
  await expect(modernPhone.getByRole("button", { name: "คิวผลัดกันร้อง: เปิด" }))
    .toHaveAttribute("aria-pressed", "true");
  await modernPhone.close();

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

  // The quiet display receives it over the socket in the compact top-centre title.
  await expect(page.locator(".hosted-meta-text h1")).toHaveText("เพลงทดสอบ Karaoke", { timeout: 10_000 });
  await expect(page.locator(".hosted-meta-text h1")).toBeVisible();

  // Add three waiting tracks, then reorder them from the phone UI.
  const waitingTitles = ["เพลงคิว A", "เพลงคิว B", "เพลงคิว C"];
  for (const [index, title] of waitingTitles.entries()) {
    const queued = await request.post(`/api/v1/rooms/${hostSession.roomId}/queue`, {
      headers: { Authorization: `Bearer ${controller.token}` },
      data: { track: { videoId: `queue00000${index}`, title, channelTitle: "QA" } }
    });
    expect(queued.ok()).toBeTruthy();
  }

  // The phone's queue tab reflects the shared waiting queue.
  await phone.getByRole("button", { name: /^คิว(?: \(\d+\))?$/ }).click();
  await expect(phone.getByText("เพลงทดสอบ Karaoke")).toBeVisible();
  const queueTitles = phone.locator(".queue-tab ol li strong");
  await expect(queueTitles).toHaveText(waitingTitles);

  await phone.getByRole("button", { name: "สลับคิว" }).click();
  await expect(phone.getByRole("button", { name: "เสร็จสิ้น" })).toHaveAttribute("aria-pressed", "true");

  // Move queue #3 to #1 (two upward steps), then move the old #1 down one slot.
  await phone.getByRole("button", { name: "ย้าย เพลงคิว C ขึ้น" }).click();
  await expect(queueTitles).toHaveText(["เพลงคิว A", "เพลงคิว C", "เพลงคิว B"]);
  await phone.getByRole("button", { name: "ย้าย เพลงคิว C ขึ้น" }).click();
  await expect(queueTitles).toHaveText(["เพลงคิว C", "เพลงคิว A", "เพลงคิว B"]);
  await phone.getByRole("button", { name: "ย้าย เพลงคิว A ลง" }).click();
  await expect(queueTitles).toHaveText(["เพลงคิว C", "เพลงคิว B", "เพลงคิว A"]);

  const reordered = await request.get(`/api/v1/rooms/${hostSession.roomId}/queue`, {
    headers: { Authorization: `Bearer ${controller.token}` }
  });
  const reorderedView = (await reordered.json()).data;
  expect(reorderedView.current.title).toBe("เพลงทดสอบ Karaoke");
  expect(reorderedView.queue.map((track) => track.title)).toEqual(["เพลงคิว C", "เพลงคิว B", "เพลงคิว A"]);

  await phone.getByRole("button", { name: "เสร็จสิ้น" }).click();
  await expect(phone.getByRole("button", { name: "สลับคิว" })).toHaveAttribute("aria-pressed", "false");
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
