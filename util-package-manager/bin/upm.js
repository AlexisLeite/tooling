#!/usr/bin/env node

import { Command } from "commander";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { initCommand } from "../src/commands/init.js";
import { installCommand } from "../src/commands/install.js";
import { updateCommand } from "../src/commands/update.js";
import { requireConfig } from "../src/config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageJson = JSON.parse(readFileSync(resolve(__dirname, "..", "package.json"), "utf8"));
const program = new Command();

program
  .name("upm")
  .description("Utility package manager for agent resources")
  .version(packageJson.version);

program
  .command("init")
  .description("Create upm.json in the current directory")
  .action(async () => {
    await initCommand();
  });

program
  .command("install")
  .description("Install resources from an npm package")
  .argument("<name>", "npm package name")
  .action(async (name) => {
    const config = await requireConfig();
    await installCommand(config, name);
  });

program
  .command("update")
  .description("Update installed packages and resources")
  .action(async () => {
    const config = await requireConfig();
    await updateCommand(config);
  });

program.parseAsync().catch((error) => {
  console.error(`[upm] ${error.message}`);
  process.exit(1);
});
