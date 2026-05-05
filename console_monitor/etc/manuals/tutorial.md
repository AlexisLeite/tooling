# Console Monitor Tutorial

This manual explains how to run arbitrary commands through `cm` and how to configure the `console-monitor` MCP server.

When installed by a resource manager, place this manual under:

```text
docs/console-monitor/tutorial.md
```

## Run A Command

Use `cm run` to wrap any long-lived command:

```bash
cm run -- pnpm dev
cm run -- npm run watch
cm run -- pytest --watch
```

The command after `--` is executed as-is. The monitor starts a local TCP server and mirrors the child process output to the current terminal.

## Workspace And Port File

By default, `cm run` uses the current directory as the workspace and writes:

```text
dev_current_port
```

inside that workspace.

Use `--cwd` when the command should run from another directory:

```bash
cm run --cwd C:\Code\my-app -- pnpm dev
```

Use `--port` to request a starting TCP port: 

```bash
cm run --port 4010 -- pnpm dev
```

If that port is busy, the monitor tries the next available port and writes the active port to `dev_current_port`.

Use `--port-file` only when a custom port-file location is needed:

```bash
cm run --port-file C:\tmp\my-app-console-port -- pnpm dev
```

## TCP Protocol

The TCP server accepts one command per line:

```text
read()
read(25)
restart()
```

`read()` returns the default number of buffered lines. `read(25)` returns up to 25 recent lines. `restart()` clears buffered output and restarts the wrapped command.

## MCP Configuration

Configure the MCP server with `cm mcp`:

```toml
[mcp_servers.console-monitor]
command = "npx"
args = ["-y", "@focus.matters/console-monitor", "mcp"]
```

For reliable workspace resolution, provide `CONSOLE_MONITOR_WORKSPACE`:

```toml
[mcp_servers.console-monitor]
command = "npx"
args = ["-y", "@focus.matters/console-monitor", "mcp"]

[mcp_servers.console-monitor.env]
CONSOLE_MONITOR_WORKSPACE = "C:\\Code\\my-app"
```

For local development before publishing:

```toml
[mcp_servers.console-monitor]
command = "node"
args = ["C:\\Code\\tooling\\console_monitor\\bin\\cm.js", "mcp"]

[mcp_servers.console-monitor.env]
CONSOLE_MONITOR_WORKSPACE = "C:\\Code\\my-app"
```

## MCP Tools

The MCP server exposes:

- `console_port`: read the active TCP port for a workspace.
- `console_read`: read recent output from the monitored command.
- `console_restart`: restart the monitored command.

The tools accept `cwd` or `portFile`. Prefer `cwd` for normal use.
