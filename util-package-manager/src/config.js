import { access, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve } from "node:path";
import { UPM_CONFIG_FILE } from "./constants.js";

export function configPath(cwd = process.cwd()) {
  return resolve(cwd, UPM_CONFIG_FILE);
}

export async function pathExists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function readConfig(cwd = process.cwd()) {
  const path = configPath(cwd);
  const raw = await readFile(path, "utf8");
  return {
    path,
    data: JSON.parse(raw)
  };
}

export async function requireConfig(cwd = process.cwd()) {
  const path = configPath(cwd);
  if (!(await pathExists(path))) {
    throw new Error("upm.json not found. Run `upm init` first.");
  }

  return readConfig(cwd);
}

export async function writeConfig(data, cwd = process.cwd()) {
  const path = configPath(cwd);
  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  return path;
}
