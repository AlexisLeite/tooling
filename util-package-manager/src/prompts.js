import { checkbox, confirm, input } from "@inquirer/prompts";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { availableResources, RESOURCE_TYPES } from "./resources.js";

export async function initPrompts(defaults) {
  const configTomlPath = await input({
    message: "Path to config.toml",
    default: defaults.configTomlPath
  });

  const codexPath = await input({
    message: "Path to .codex directory",
    default: defaults.codexPath
  });

  return {
    configTomlPath: resolve(configTomlPath),
    codexPath: resolve(codexPath)
  };
}

export function defaultInitPaths() {
  const userHome = homedir();
  return {
    configTomlPath: resolve(userHome, ".codex", "config.toml"),
    codexPath: resolve(process.cwd(), ".codex")
  };
}

export async function selectResources(utilPackage, previousSelection) {
  const available = availableResources(utilPackage);
  const selection = {};

  for (const type of RESOURCE_TYPES) {
    const names = available[type];
    if (names.length === 0) {
      selection[type] = [];
      continue;
    }

    selection[type] = await checkbox({
      message: `Select ${type}`,
      choices: names.map((name) => ({
        name: resourceLabel(type, name, utilPackage[type]?.[name]),
        value: name,
        checked: previousSelection?.[type]?.includes(name) ?? true
      }))
    });
  }

  return selection;
}

export async function chooseUpdates(packagesWithUpdates) {
  if (packagesWithUpdates.length === 0) {
    return [];
  }

  return checkbox({
    message: "Select packages to update",
    choices: packagesWithUpdates.map((entry) => ({
      name: `${entry.name} ${entry.currentVersion} -> ${entry.latestVersion}`,
      value: entry.name,
      checked: true
    }))
  });
}

export async function confirmInstall(name) {
  return confirm({
    message: `Install resources from ${name}?`,
    default: true
  });
}

function resourceLabel(type, name, definition) {
  const description = definition?.description ? ` - ${definition.description}` : "";
  return `${type}:${name}${description}`;
}
