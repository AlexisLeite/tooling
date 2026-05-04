#!/usr/bin/env node

import { runConsoleMonitor, printRunUsage } from "../src/run.js";

function printUsage() {
  console.error(
    [
      "Usage:",
      "  cm run [--port <number>] [--host <host>] [--cwd <path>] [--port-file <path>] -- <command> [args...]",
      "  cm run [--port <number>] [--host <host>] [--cwd <path>] [--port-file <path>] <command> [args...]",
      "",
      "Commands:",
      "  run    Run a command and expose its console over TCP",
    ].join("\n")
  );
}

const [command, ...args] = process.argv.slice(2);

if (command === "--help" || command === "-h" || !command) {
  printUsage();
  process.exit(command ? 0 : 1);
}

if (command !== "run") {
  console.error(`[cm] Unsupported command: ${command}`);
  printUsage();
  process.exit(1);
} else {
  try {
    runConsoleMonitor(args);
  } catch (error) {
    console.error(`[cm] ${error.message}`);
    printRunUsage();
    process.exit(1);
  }
}
