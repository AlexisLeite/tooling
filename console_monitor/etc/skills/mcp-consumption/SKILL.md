---
name: mcp-consumption
description: Use when Codex needs to inspect, monitor, or restart output from a running console command through the console-monitor MCP server. Trigger during development workflows that involve dev servers, watch processes, test watchers, build watchers, or any process already launched with cm run, especially when Codex needs to verify compilation, runtime errors, readiness, or regressions.
---

# Console Monitor MCP Consumption

Use the `console-monitor` MCP server to read or restart commands that were launched through `cm run`.

## Tool Selection

- Use `console_read` proactively when a running dev server, watcher, test process, or arbitrary monitored command can confirm whether the current work is compiling, serving, passing, or failing.
- Use `console_restart` when the monitored command should be restarted after code/config changes, stale state, or dependency updates.
- Use `console_port` only when debugging connection or port-file issues.

## Workspace

Pass `cwd` explicitly when the current repository path is known. The MCP server uses that directory to find `dev_current_port`.

If `cwd` is not supplied, the MCP server falls back to `CONSOLE_MONITOR_WORKSPACE` and then its own process working directory. Do not guess TCP ports unless the port file is missing or the user explicitly provides a port.

## Reading Output

Read enough lines to answer the immediate question. Start with 50 lines for diagnosis, then request more only when the relevant error or startup message is not visible.

When output is empty, report that the monitor is reachable but has no buffered output. Then check whether the process has started, whether the wrong `cwd` was supplied, or whether the command exited and removed `dev_current_port`.

## Restarting

Use `console_restart` instead of asking the user to stop and start the process when the wrapped command supports a normal restart. After restart, read output again to confirm the process came back up.
