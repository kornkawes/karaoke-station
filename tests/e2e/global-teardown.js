import { removeCurrentE2eData } from "./temp-data.js";

export default async function globalTeardown() {
  await removeCurrentE2eData();
}
