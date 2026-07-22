import { fetchPackageMetadata, hasUpdate, latestVersion, packageJsonForVersion, utilPackageFromPackageJson, downloadAndExtractPackage } from "../npm.js";
import { chooseUpdates } from "../prompts.js";
import { installSelectedResources, normalizeSelection, storePackageDir } from "../resources.js";
import { printSummary } from "../summary.js";
import { writeConfig } from "../config.js";

export async function updateCommand(config) {
  const installedPackages = Object.entries(config.data.packages || {});
  if (installedPackages.length === 0) {
    console.log("No packages installed.");
    return;
  }

  const updates = [];
  for (const [name, installed] of installedPackages) {
    const metadata = await fetchPackageMetadata(name);
    const candidate = latestVersion(metadata);
    if (hasUpdate(installed.version, candidate)) {
      updates.push({
        name,
        currentVersion: installed.version,
        latestVersion: candidate,
        metadata
      });
    }
  }

  if (updates.length === 0) {
    console.log("All packages are up to date.");
    return;
  }

  const selectedNames = new Set(await chooseUpdates(updates));
  if (selectedNames.size === 0) {
    console.log("Update cancelled.");
    return;
  }

  for (const update of updates) {
    if (!selectedNames.has(update.name)) continue;

    const pkg = packageJsonForVersion(update.metadata, update.latestVersion);
    const utilPackage = utilPackageFromPackageJson(pkg);
    if (!utilPackage) {
      console.log(`${update.name}@${update.latestVersion} no longer declares util-package resources. Skipping.`);
      continue;
    }

    const previous = config.data.packages[update.name];
    const selection = normalizeSelection(previous.resources);
    const needsPackageFiles =
      selection.commands.length > 0
      || selection.binaries.length > 0
      || selection.skills.length > 0
      || selection.manuals.length > 0
      || selection.hooks.length > 0
      || Object.keys(utilPackage.postInstall || {}).length > 0;
    if (needsPackageFiles) {
      const packageDir = storePackageDir(update.name, update.latestVersion);
      await downloadAndExtractPackage(pkg, packageDir);
    }

    const installed = await installSelectedResources({
      packageName: update.name,
      version: update.latestVersion,
      selected: selection,
      utilPackage,
      config
    });

    config.data.packages[update.name] = {
      version: update.latestVersion,
      resources: selection
    };

    printSummary({
      packageName: update.name,
      version: update.latestVersion,
      added: installed,
      removed: []
    });
  }

  await writeConfig(config.data);
}
