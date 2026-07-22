import { readdir, readFile } from "node:fs/promises";
import { resolve, relative } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const rootDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const packageScope = "@focus.matters/";
const ignoredDirectories = new Set([".git", ".upm", "node_modules", "test"]);
const npmCliPath = process.env.npm_execpath;
const npmCommand = npmCliPath ? process.execPath : "npm";
const npmCommandPrefix = npmCliPath ? [npmCliPath] : [];
const useShell = process.platform === "win32" && !npmCliPath;

function npmArguments(args) {
  return [...npmCommandPrefix, ...args];
}

function parseVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  return match ? match.slice(1).map(Number) : null;
}

function atLeast(version, minimum) {
  const actual = parseVersion(version);
  const required = parseVersion(minimum);
  if (actual === null || required === null) return false;

  for (let index = 0; index < required.length; index += 1) {
    if (actual[index] !== required[index]) return actual[index] > required[index];
  }
  return true;
}

function run(command, args, cwd) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd, stdio: "inherit", shell: useShell });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolveRun();
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} failed${signal ? ` (${signal})` : ` with exit code ${code}`}`));
    });
  });
}

function runCaptured(command, args, cwd) {
  return new Promise((resolveRun, reject) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(command, args, { cwd, shell: useShell });
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        resolveRun(stdout.trim());
        return;
      }
      reject(new Error(stderr.trim() || `${command} ${args.join(" ")} failed with exit code ${code}`));
    });
  });
}

async function verifyStagingRequirements() {
  if (!atLeast(process.versions.node, "22.14.0")) {
    throw new Error(`npm stage publish requires Node.js 22.14.0 or later; found ${process.versions.node}.`);
  }

  const npmVersion = await runCaptured(npmCommand, npmArguments(["--version"]), rootDir);
  if (!atLeast(npmVersion, "11.15.0")) {
    throw new Error(`npm stage publish requires npm 11.15.0 or later; found ${npmVersion}.`);
  }
}

async function readPackage(directory) {
  try {
    const manifestPath = resolve(directory, "package.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    if (
      manifest.private === true
      || typeof manifest.name !== "string"
      || !manifest.name.startsWith(packageScope)
      || typeof manifest.version !== "string"
      || parseVersion(manifest.version) === null
    ) {
      return null;
    }
    return { directory, name: manifest.name, version: manifest.version };
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new Error(`Invalid package.json in ${relative(rootDir, directory) || "."}: ${error.message}`);
  }
}

async function findPackages(directory = rootDir, discovered = []) {
  const packageInfo = await readPackage(directory);
  if (packageInfo) discovered.push(packageInfo);

  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || ignoredDirectories.has(entry.name)) continue;
    await findPackages(resolve(directory, entry.name), discovered);
  }

  return discovered;
}

async function isAlreadyPublished(packageInfo) {
  try {
    await runCaptured(npmCommand, npmArguments(["view", packageInfo.name, "version", "--json"]), packageInfo.directory);
    return true;
  } catch (error) {
    if (/\b404\b/.test(error.message)) return false;
    throw error;
  }
}

async function main() {
  await verifyStagingRequirements();
  const packages = (await findPackages()).sort((left, right) => left.name.localeCompare(right.name));
  if (packages.length === 0) {
    console.log(`No publishable ${packageScope} packages found.`);
    return;
  }

  const failures = [];
  for (const packageInfo of packages) {
    const path = relative(rootDir, packageInfo.directory) || ".";
    try {
      if (!await isAlreadyPublished(packageInfo)) {
        console.log(`\nSkipping ${packageInfo.name}: npm stage publish only supports packages already published to npm.`);
        continue;
      }

      console.log(`\nBumping ${packageInfo.name}@${packageInfo.version} from ${path}`);
      await run(npmCommand, npmArguments(["version", "patch", "--no-git-tag-version", "--ignore-scripts"]), packageInfo.directory);

      const bumpedPackage = await readPackage(packageInfo.directory);
      console.log(`Staging ${bumpedPackage.name}@${bumpedPackage.version} from ${path}`);
      await run(npmCommand, npmArguments(["stage", "publish", "--access", "public"]), packageInfo.directory);
    } catch (error) {
      failures.push(`${packageInfo.name}@${packageInfo.version}: ${error.message}`);
    }
  }

  if (failures.length > 0) {
    console.error(`\nFailed to stage ${failures.length} package(s):`);
    for (const failure of failures) console.error(`- ${failure}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`Unable to stage packages: ${error.message}`);
  process.exitCode = 1;
});
