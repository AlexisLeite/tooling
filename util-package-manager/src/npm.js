import { mkdir, readFile, rm } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import * as tar from "tar";
import semver from "semver";
import { UTIL_PACKAGE_KEY } from "./constants.js";

const REGISTRY = "https://registry.npmjs.org";

function registryUrl(name) {
  return `${REGISTRY}/${encodeURIComponent(name).replace(/^%40/, "@")}`;
}

export async function fetchPackageMetadata(name) {
  const response = await fetch(registryUrl(name), {
    headers: {
      accept: "application/json"
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to query npm for ${name}: ${response.status} ${response.statusText}`);
  }

  return response.json();
}

export function latestVersion(metadata) {
  return metadata?.["dist-tags"]?.latest;
}

export function packageJsonForVersion(metadata, version) {
  const resolvedVersion = version || latestVersion(metadata);
  const pkg = metadata?.versions?.[resolvedVersion];
  if (!pkg) {
    throw new Error(`Version ${resolvedVersion} not found for ${metadata.name}`);
  }
  return pkg;
}

export function utilPackageFromPackageJson(pkg) {
  return pkg?.[UTIL_PACKAGE_KEY] || null;
}

export function hasUpdate(currentVersion, candidateVersion) {
  return Boolean(candidateVersion && semver.valid(currentVersion) && semver.gt(candidateVersion, currentVersion));
}

export async function downloadAndExtractPackage(pkg, targetDir) {
  const tarballUrl = pkg?.dist?.tarball;
  if (!tarballUrl) {
    throw new Error(`Package ${pkg.name}@${pkg.version} has no tarball URL`);
  }

  await rm(targetDir, { recursive: true, force: true });
  await mkdir(targetDir, { recursive: true });

  const archivePath = join(tmpdir(), `upm-${pkg.name.replace(/[\\/]/g, "-")}-${pkg.version}-${Date.now()}.tgz`);
  const response = await fetch(tarballUrl);
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download ${pkg.name}@${pkg.version}: ${response.status} ${response.statusText}`);
  }

  await pipeline(response.body, createWriteStream(archivePath));
  await tar.x({
    file: archivePath,
    cwd: targetDir,
    strip: 1
  });
  await rm(archivePath, { force: true });

  return targetDir;
}

export async function readPackageManifestFromExtracted(targetDir, manifestPath) {
  const resolved = resolve(targetDir, manifestPath);
  return JSON.parse(await readFile(resolved, "utf8"));
}
