import { expect, test } from "@playwright/test";

/**
 * The catalog endpoint is deliberately intercepted here so this hosted UI test
 * never depends on Google credentials or a live Sheet. The assertion that the
 * YouTube search endpoint stays untouched is the important contract: typing is
 * served by the cached catalog only.
 */
test("catalog autocomplete queues a real track without a YouTube search", async ({ page, context }) => {
  await page.route("https://www.youtube.com/**", (route) => route.abort());
  await page.goto("/display");
  const host = await expect.poll(() => page.evaluate(() => {
    const value = sessionStorage.getItem("karaoke.hostSession");
    return value ? JSON.parse(value) : null;
  })).not.toBeNull().then(() => page.evaluate(() => JSON.parse(sessionStorage.getItem("karaoke.hostSession"))));

  const phone = await context.newPage();
  await phone.setViewportSize({ width: 390, height: 844 });
  const catalogRequests = [];
  const searchRequests = [];
  await phone.route("**/api/v1/rooms/*/catalog/suggestions*", async (route) => {
    catalogRequests.push(new URL(route.request().url()));
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        data: {
          suggestions: [{
            artist: "Mirrr",
            title: "เพลงจากคลังจริง",
            videoId: "dQw4w9WgXcQ",
            channelTitle: "Mirrr Official",
            classification: "karaoke",
            badge: "Karaoke"
          }]
        }
      })
    });
  });
  await phone.route("**/api/v1/rooms/*/search*", async (route) => {
    searchRequests.push(new URL(route.request().url()));
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: { results: [] } })
    });
  });

  await phone.goto(host.joinPath);
  await phone.getByLabel("ชื่อของคุณ").fill("มือถือ catalog");
  await phone.getByRole("button", { name: "เข้าร่วมห้อง", exact: true }).click();
  await expect(phone.locator(".search-box input")).toBeEnabled();

  await phone.locator(".search-box input").fill("เพลงจากคลัง");
  await expect(phone.locator(".catalog-suggestions")).toBeVisible();
  await expect(phone.locator(".catalog-suggestions [role=option]")).toContainText("เพลงจากคลังจริง");
  await expect(phone.locator(".catalog-suggestions [role=option]")).toContainText("Mirrr");
  await expect(phone.locator(".catalog-suggestions code")).toHaveCount(0);
  await expect(phone.getByRole("button", { name: "บันทึกเพลงโปรด" })).toBeVisible();
  await expect(phone.getByRole("button", { name: /เพิ่ม เพลงจากคลังจริง เข้าคิว/ })).toBeVisible();
  await phone.getByRole("button", { name: "บันทึกเพลงโปรด" }).click();
  await expect(phone.getByRole("button", { name: "ลบจากเพลงโปรด" })).toBeVisible();
  expect(catalogRequests.length).toBeGreaterThanOrEqual(1);
  expect(searchRequests).toHaveLength(0);

  await phone.locator(".catalog-suggestions [role=option]").click();
  await expect(phone.locator(".search-box input")).toHaveValue("");
  await expect(phone.locator(".catalog-suggestions")).toHaveCount(0);
  await expect(phone.locator(".toast")).toContainText("เพิ่ม “เพลงจากคลังจริง” เข้าคิวแล้ว");
  expect(searchRequests).toHaveLength(0);
  await expect(page.locator(".system-track-bar")).toContainText("เพลงจากคลังจริง", { timeout: 15_000 });

  const queue = await phone.evaluate(() => fetch("/api/v1/rooms/" + JSON.parse(sessionStorage.getItem("karaoke.controllerSession")).roomId + "/queue", {
    headers: { Authorization: "Bearer " + JSON.parse(sessionStorage.getItem("karaoke.controllerSession")).token }
  }).then((response) => response.json()));
  expect(queue.data.current.videoId).toBe("dQw4w9WgXcQ");
});

test("submitting while catalog suggestions are visible still runs the YouTube search", async ({ page, context }) => {
  await page.goto("/display");
  const host = await expect.poll(() => page.evaluate(() => {
    const value = sessionStorage.getItem("karaoke.hostSession");
    return value ? JSON.parse(value) : null;
  })).not.toBeNull().then(() => page.evaluate(() => JSON.parse(sessionStorage.getItem("karaoke.hostSession"))));

  const phone = await context.newPage();
  await phone.setViewportSize({ width: 390, height: 844 });
  const searchRequests = [];
  await phone.route("**/api/v1/rooms/*/catalog/suggestions*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: { suggestions: [{ artist: "คลัง", title: "เพลงแนะนำ", videoId: "dQw4w9WgXcQ" }] } })
    });
  });
  await phone.route("**/api/v1/rooms/*/search*", async (route) => {
    searchRequests.push(new URL(route.request().url()));
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: { results: [{ title: "ผลจาก API", videoId: "M7lc1UVf-VE", channelTitle: "API", badge: "Karaoke" }] } })
    });
  });

  await phone.goto(host.joinPath);
  await phone.getByLabel("ชื่อของคุณ").fill("มือถือ API");
  await phone.getByRole("button", { name: "เข้าร่วมห้อง", exact: true }).click();
  await expect(phone.locator(".search-box input")).toBeEnabled();
  await phone.locator(".search-box input").fill("เพลงที่มีในคลัง");
  await expect(phone.locator(".catalog-suggestions")).toBeVisible();
  await phone.locator(".search-box button").click();
  await expect.poll(() => searchRequests.length).toBe(1);
  await expect(phone.locator(".song-row")).toContainText("ผลจาก API");
  await expect(phone.locator(".catalog-suggestions")).toHaveCount(0);
});

test("catalog suggestions keep three visible rows and scroll the rest", async ({ page, context }) => {
  await page.goto("/display");
  const host = await expect.poll(() => page.evaluate(() => {
    const value = sessionStorage.getItem("karaoke.hostSession");
    return value ? JSON.parse(value) : null;
  })).not.toBeNull().then(() => page.evaluate(() => JSON.parse(sessionStorage.getItem("karaoke.hostSession"))));

  const phone = await context.newPage();
  await phone.setViewportSize({ width: 390, height: 844 });
  await phone.route("**/api/v1/rooms/*/catalog/suggestions*", async (route) => {
    const videoIds = ["dQw4w9WgXcQ", "M7lc1UVf-VE", "9bZkp7q19f0", "kJQP7kiw5Fk", "fJ9rUzIMcZQ"];
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: { suggestions: videoIds.map((videoId, index) => ({ artist: "คลัง", title: `เพลงแนะนำ ${index + 1}`, videoId })) } })
    });
  });

  await phone.goto(host.joinPath);
  await phone.getByLabel("ชื่อของคุณ").fill("มือถือ dropdown");
  await phone.getByRole("button", { name: "เข้าร่วมห้อง", exact: true }).click();
  await expect(phone.locator(".search-box input")).toBeEnabled();
  await phone.locator(".search-box input").fill("เพลงแนะนำ");
  await expect(phone.locator(".catalog-suggestions li")).toHaveCount(5);
  const menu = await phone.locator(".catalog-suggestions").evaluate((node) => {
    const style = getComputedStyle(node);
    return { maxHeight: style.maxHeight, clientHeight: node.clientHeight, scrollHeight: node.scrollHeight };
  });
  expect(menu.maxHeight).toBe("178px");
  expect(menu.scrollHeight).toBeGreaterThan(menu.clientHeight);
});

test("catalog autocomplete falls back to YouTube search only when submitted without a row", async ({ page, context }) => {
  await page.goto("/display");
  const host = await expect.poll(() => page.evaluate(() => {
    const value = sessionStorage.getItem("karaoke.hostSession");
    return value ? JSON.parse(value) : null;
  })).not.toBeNull().then(() => page.evaluate(() => JSON.parse(sessionStorage.getItem("karaoke.hostSession"))));

  const phone = await context.newPage();
  await phone.setViewportSize({ width: 390, height: 844 });
  const searchRequests = [];
  await phone.route("**/api/v1/rooms/*/catalog/suggestions*", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { suggestions: [] } }) });
  });
  await phone.route("**/api/v1/rooms/*/search*", async (route) => {
    searchRequests.push(new URL(route.request().url()));
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { results: [] } }) });
  });

  await phone.goto(host.joinPath);
  await phone.getByLabel("ชื่อของคุณ").fill("มือถือ search");
  await phone.getByRole("button", { name: "เข้าร่วมห้อง", exact: true }).click();
  await expect(phone.locator(".search-box input")).toBeEnabled();
  await phone.locator(".search-box input").fill("คำค้นที่ไม่มีในคลัง");
  await expect(phone.locator(".catalog-suggestions")).toHaveCount(0);
  await phone.locator(".search-box button").click();
  await expect.poll(() => searchRequests.length).toBe(1);
  expect(searchRequests[0].searchParams.get("limit")).toBe("30");
});

test("direct YouTube input bypasses catalog and keeps the resolve flow", async ({ page, context }) => {
  await page.route("https://www.youtube.com/**", (route) => route.abort());
  await page.goto("/display");
  const host = await expect.poll(() => page.evaluate(() => {
    const value = sessionStorage.getItem("karaoke.hostSession");
    return value ? JSON.parse(value) : null;
  })).not.toBeNull().then(() => page.evaluate(() => JSON.parse(sessionStorage.getItem("karaoke.hostSession"))));

  const phone = await context.newPage();
  await phone.setViewportSize({ width: 390, height: 844 });
  const catalogRequests = [];
  const searchRequests = [];
  const resolveRequests = [];
  await phone.route("**/api/v1/rooms/*/catalog/suggestions*", async (route) => {
    catalogRequests.push(route.request().url());
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: { suggestions: [] } })
    });
  });
  await phone.route("**/api/v1/rooms/*/search*", async (route) => {
    searchRequests.push(route.request().url());
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { results: [] } }) });
  });
  await phone.route("**/api/v1/rooms/*/youtube/resolve", async (route) => {
    resolveRequests.push(new URL(route.request().url()));
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: {
        videoId: "dQw4w9WgXcQ",
        title: "เพลงจากลิงก์ตรง",
        channelTitle: "ช่องตรง",
        classification: "karaoke",
        badge: "Karaoke"
      } })
    });
  });

  await phone.goto(host.joinPath);
  await phone.getByLabel("ชื่อของคุณ").fill("มือถือ direct");
  await phone.getByRole("button", { name: "เข้าร่วมห้อง", exact: true }).click();
  await expect(phone.locator(".search-box input")).toBeEnabled();
  await phone.locator(".search-box input").fill("https://youtu.be/dQw4w9WgXcQ");
  await phone.locator(".search-box button").click();

  await expect.poll(() => resolveRequests.length).toBe(1);
  expect(catalogRequests).toHaveLength(0);
  expect(searchRequests).toHaveLength(0);
  await expect(phone.locator(".song-row")).toContainText("เพลงจากลิงก์ตรง");
  expect(resolveRequests[0].pathname).toContain("/youtube/resolve");
});
