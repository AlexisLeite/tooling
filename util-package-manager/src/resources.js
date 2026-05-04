import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { UPM_STORE_DIR } from "./constants.js";

export const RESOURCE_TYPES = ["commands", "mcpServers", "skills", "manuals"];

export function emptySelection() {
  return {
    commands: [],
    mcpServers: [],
    skills: [],
    manuals: []
  };
}

export function availableResources(utilPackage) {
  const result = {};
  for (const type of RESOURCE_TYPES) {
    result[type] = Object.keys(utilPackage?.[type] || {});
  }
  return result;
}

export function hasAnyResource(utilPackage) {
  return RESOURCE_TYPES.some((type) => Object.keys(utilPackage?.[type] || {}).length > 0);
}

export function storePackageDir(packageName, version, cwd = process.cwd()) {
  const safeName = packageName.replace(/^@/, "").replace(/[\\/]/g, "__");
  return resolve(cwd, UPM_STORE_DIR, "packages", `${safeName}@${version}`);
}

export function installedCommandDir(cwd = process.cwd()) {
  return resolve(cwd, UPM_STORE_DIR, "bin");
}

export async function installCommands({ packageName, version, selected, utilPackage, config }) {
  const added = [];
  const packageDir = storePackageDir(packageName, version);
  const binDir = installedCommandDir();
  await mkdir(binDir, { recursive: true });

  for (const name of selected.commands || []) {
    const definition = utilPackage.commands?.[name];
    if (!definition) continue;

    const commandTarget = resolve(packageDir, definition.bin || definition.path || "");
    const shimPath = resolve(binDir, process.platform === "win32" ? `${name}.cmd` : name);
    const relativeNode = commandTarget;
    const contents = process.platform === "win32"
      ? `@echo off\r\nnode "${relativeNode}" %*\r\n`
      : `#!/usr/bin/env sh\nexec node "${relativeNode}" "$@"\n`;
    await writeFile(shimPath, contents, "utf8");
    added.push({ type: "command", name, path: shimPath });
  }

  config.data.paths ??= {};
  config.data.paths.commands = binDir;
  return added;
}

function tomlValue(value) {
  return JSON.stringify(value);
}

function mcpBlock(name, definition) {
  const lines = [
    "",
    `# upm:begin mcp ${name}`,
    `[mcp_servers.${JSON.stringify(name)}]`,
    `command = ${tomlValue(definition.command)}`
  ];

  if (definition.args) {
    lines.push(`args = ${JSON.stringify(definition.args)}`);
  }

  if (definition.env && Object.keys(definition.env).length > 0) {
    lines.push("");
    lines.push(`[mcp_servers.${JSON.stringify(name)}.env]`);
    for (const [key, value] of Object.entries(definition.env)) {
      lines.push(`${key} = ${tomlValue(value)}`);
    }
  }

  lines.push(`# upm:end mcp ${name}`);
  return lines.join("\n");
}

export async function installMcpServers({ selected, utilPackage, config }) {
  const added = [];
  const configTomlPath = config.data.configTomlPath;
  let content = "";

  try {
    content = await readFile(configTomlPath, "utf8");
  } catch {
    content = "";
  }

  for (const name of selected.mcpServers || []) {
    const definition = utilPackage.mcpServers?.[name];
    if (!definition) continue;

    const start = `# upm:begin mcp ${name}`;
    const end = `# upm:end mcp ${name}`;
    const pattern = new RegExp(`\\n?${escapeRegExp(start)}[\\s\\S]*?${escapeRegExp(end)}\\n?`, "g");
    content = content.replace(pattern, "\n");
    content = `${content.trimEnd()}\n${mcpBlock(name, definition)}\n`;
    added.push({ type: "mcp", name, path: configTomlPath });
  }

  await mkdir(dirname(configTomlPath), { recursive: true });
  await writeFile(configTomlPath, content, "utf8");
  return added;
}

export async function installSkills({ packageName, version, selected, utilPackage, config }) {
  const added = [];
  const packageDir = storePackageDir(packageName, version);
  const skillsRoot = resolve(config.data.codexPath, "skills");
  await mkdir(skillsRoot, { recursive: true });

  for (const name of selected.skills || []) {
    const definition = utilPackage.skills?.[name];
    if (!definition?.path) continue;

    const source = resolve(packageDir, definition.path);
    const target = resolve(skillsRoot, name);
    await rm(target, { recursive: true, force: true });
    await cp(source, target, { recursive: true });
    added.push({ type: "skill", name, path: target });
  }

  return added;
}

export async function installManuals({ packageName, version, selected, utilPackage }) {
  const added = [];
  const packageDir = storePackageDir(packageName, version);

  for (const name of selected.manuals || []) {
    const definition = utilPackage.manuals?.[name];
    if (!definition?.path || !definition?.installPath) continue;

    const source = resolve(packageDir, definition.path);
    const target = resolve(process.cwd(), definition.installPath);
    await mkdir(dirname(target), { recursive: true });
    await cp(source, target);
    added.push({ type: "manual", name, path: target });
  }

  return added;
}

export async function installSelectedResources(args) {
  const added = [];
  added.push(...await installCommands(args));
  added.push(...await installMcpServers(args));
  added.push(...await installSkills(args));
  added.push(...await installManuals(args));
  return added;
}

export async function removeSelectedResources({ selected, utilPackage, config }) {
  const removed = [];
  removed.push(...await removeCommands({ selected }));
  removed.push(...await removeMcpServers({ selected, config }));
  removed.push(...await removeSkills({ selected, config }));
  removed.push(...await removeManuals({ selected, utilPackage }));
  return removed;
}

async function removeCommands({ selected }) {
  const removed = [];
  const binDir = installedCommandDir();

  for (const name of selected.commands || []) {
    const shimPath = resolve(binDir, process.platform === "win32" ? `${name}.cmd` : name);
    await rm(shimPath, { force: true });
    removed.push({ type: "command", name, path: shimPath });
  }

  return removed;
}

async function removeMcpServers({ selected, config }) {
  const removed = [];
  const configTomlPath = config.data.configTomlPath;
  let content = "";

  try {
    content = await readFile(configTomlPath, "utf8");
  } catch {
    return removed;
  }

  for (const name of selected.mcpServers || []) {
    const start = `# upm:begin mcp ${name}`;
    const end = `# upm:end mcp ${name}`;
    const pattern = new RegExp(`\\n?${escapeRegExp(start)}[\\s\\S]*?${escapeRegExp(end)}\\n?`, "g");
    content = content.replace(pattern, "\n");
    removed.push({ type: "mcp", name, path: configTomlPath });
  }

  await writeFile(configTomlPath, `${content.trimEnd()}\n`, "utf8");
  return removed;
}

async function removeSkills({ selected, config }) {
  const removed = [];
  const skillsRoot = resolve(config.data.codexPath, "skills");

  for (const name of selected.skills || []) {
    const target = resolve(skillsRoot, name);
    await rm(target, { recursive: true, force: true });
    removed.push({ type: "skill", name, path: target });
  }

  return removed;
}

async function removeManuals({ selected, utilPackage }) {
  const removed = [];

  for (const name of selected.manuals || []) {
    const definition = utilPackage.manuals?.[name];
    if (!definition?.installPath) continue;

    const target = resolve(process.cwd(), definition.installPath);
    await rm(target, { force: true });
    removed.push({ type: "manual", name, path: target });
  }

  return removed;
}

export function diffSelections(before = emptySelection(), after = emptySelection()) {
  const added = [];
  const removed = [];

  for (const type of RESOURCE_TYPES) {
    const beforeSet = new Set(before[type] || []);
    const afterSet = new Set(after[type] || []);

    for (const value of afterSet) {
      if (!beforeSet.has(value)) added.push({ type, name: value });
    }
    for (const value of beforeSet) {
      if (!afterSet.has(value)) removed.push({ type, name: value });
    }
  }

  return { added, removed };
}

export function normalizeSelection(selection) {
  return {
    ...emptySelection(),
    ...selection
  };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
