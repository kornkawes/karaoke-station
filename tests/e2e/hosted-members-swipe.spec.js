import { expect, test } from "@playwright/test";

async function readRoomMembers(page) {
  return page.evaluate(async () => {
    const session = JSON.parse(sessionStorage.getItem("karaoke.controllerSession"));
    const response = await fetch(`/api/v1/rooms/${session.roomId}/queue`, {
      headers: { Authorization: `Bearer ${session.token}` }
    });
    const body = await response.json();
    return body.data?.members || [];
  });
}

async function join(page, joinPath, name) {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => {
    sessionStorage.removeItem("karaoke.controllerSession");
    localStorage.removeItem("karaoke.controllerRecovery");
  });
  const target = new URL(joinPath, "http://127.0.0.1:43180");
  await page.goto(`${target.pathname}${target.search}${target.hash}`);
  await expect(page.getByLabel("ชื่อของคุณ")).toBeVisible({ timeout: 15_000 });
  await page.getByLabel("ชื่อของคุณ").fill(name);
  await page.getByRole("button", { name: "เข้าร่วมห้อง", exact: true }).click();
  await expect(page.locator(".search-box input")).toBeEnabled();
}

test("leader reveals kick actions by swiping a member row", async ({ page, context }) => {
  await page.goto("/display");
  await expect(page.locator(".display-stage[data-display-mode=\"invite\"]")).toBeVisible();
  const host = await page.evaluate(() => JSON.parse(sessionStorage.getItem("karaoke.hostSession")));
  const leader = await context.newPage();
  const guest = await context.newPage();
  try {
    await join(leader, host.joinPath, "Swipe Leader");
    await join(guest, host.joinPath, "Swipe Guest");
    await expect.poll(() => readRoomMembers(leader), { timeout: 15_000 }).toEqual(expect.arrayContaining([
      expect.objectContaining({ displayName: "Swipe Leader", isLeader: true }),
      expect.objectContaining({ displayName: "Swipe Guest", isLeader: false })
    ]));

    await leader.getByRole("button", { name: "ดูข้อมูลห้อง", exact: true }).click();
    const row = leader.locator(".member-row").filter({ hasText: "Swipe Guest" }).first();
    await expect(row).toBeVisible();
    const box = await row.boundingBox();
    expect(box).not.toBeNull();
    await leader.mouse.move(box.x + box.width - 70, box.y + box.height / 2);
    await leader.mouse.down();
    await leader.mouse.move(box.x + box.width - 150, box.y + box.height / 2, { steps: 6 });
    await leader.mouse.up();

    await expect(leader.locator(".member-swipe-actions.is-visible")).toBeVisible();
    await expect(leader.getByRole("button", { name: "เตะ Swipe Guest ออก" })).toBeVisible();
    await expect(leader.getByRole("button", { name: "ยกเลิก" })).toBeVisible();
  } finally {
    await page.evaluate(async () => {
      const session = JSON.parse(sessionStorage.getItem("karaoke.hostSession"));
      await fetch(`/api/v1/rooms/${session.roomId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${session.token}`, "Content-Type": "application/json" },
        body: "{}"
      });
    }).catch(() => {});
    await leader.close();
    await guest.close();
  }
});
