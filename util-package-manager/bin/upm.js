#!/usr/bin/env node

import { Command } from "commander";
import { initCommand } from "../src/commands/init.js";
import { installCommand } from "../src/commands/install.js";
import { updateCommand } from "../src/commands/update.js";
import { requireConfig } from "../src/config.js";

const program = new Command();

program
  .name("upm")
  .description("Utility package manager for agent resources")
  .version("0.1.0");

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
