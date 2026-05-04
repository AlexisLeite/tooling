#!/usr/bin/env node

import { main } from "../src/mcp.js";

main().catch((error) => {
  console.error(`[console-monitor-mcp] ${error.stack || error.message}`);
  process.exit(1);
});
