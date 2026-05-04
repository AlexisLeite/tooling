import { downloadAndExtractPackage, fetchPackageMetadata, latestVersion, packageJsonForVersion, utilPackageFromPackageJson } from "../npm.js";
import { confirmInstall, selectResources } from "../prompts.js";
import { diffSelections, emptySelection, hasAnyResource, installSelectedResources, normalizeSelection, removeSelectedResources, storePackageDir } from "../resources.js";
import { printSummary } from "../summary.js";
import { writeConfig } from "../config.js";

export async function installCommand(config, name) {
  const metadata = await fetchPackageMetadata(name);
  const version = latestVersion(metadata);
  const pkg = packageJsonForVersion(metadata, version);
  const utilPackage = utilPackageFromPackageJson(pkg);

  if (!utilPackage) {
    console.log(`${name}@${version} does not declare util-package resources.`);
    return;
  }

  if (!hasAnyResource(utilPackage)) {
    console.log(`${name}@${version} declares util-package but has no resources.`);
    return;
  }

  const proceed = await confirmInstall(`${name}@${version}`);
  if (!proceed) {
    console.log("Install cancelled.");
    return;
  }

  const previousPackage = config.data.packages?.[name];
  const previousSelection = normalizeSelection(previousPackage?.resources);
  const selection = normalizeSelection(await selectResources(utilPackage, previousSelection));
  const diff = diffSelections(previousSelection, selection);

  const packageDir = storePackageDir(name, version);
  await downloadAndExtractPackage(pkg, packageDir);

  const selectedRemoved = emptySelection();
  for (const entry of diff.removed) {
    selectedRemoved[entry.type].push(entry.name);
  }
  const removed = await removeSelectedResources({ selected: selectedRemoved, utilPackage, config });

  const installed = await installSelectedResources({
    packageName: name,
    version,
    selected: selection,
    utilPackage,
    config
  });

  config.data.packages ??= {};
  config.data.packages[name] = {
    version,
    resources: selection
  };
  await writeConfig(config.data);

  printSummary({
    packageName: name,
    version,
    added: installed,
    removed
  });
}
