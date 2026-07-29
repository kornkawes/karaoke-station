import { promises as fsPromises } from "node:fs";

export const {
  copyFile,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile
} = fsPromises;
