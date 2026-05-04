# @focus.matters/console-monitor

Run a long-lived command and expose its console to local agents.

## CLI

```bash
cm run -- pnpm dev
cm run --port 4010 -- npm run watch
cm run --cwd /path/to/project -- pnpm dev
```

`cm run` starts the wrapped command and a TCP server. By default it writes the active TCP port to:

```text
<cwd>/dev_current_port
```

If the requested port is busy, it tries the next port. The TCP protocol accepts:

```text
read()
read(25)
restart()
```

## MCP

Start the MCP server with:

```bash
console-monitor-mcp
cm mcp
```

It exposes these tools:

- `console_port`: reads the active TCP port.
- `console_read`: reads recent console output.
- `console_restart`: restarts the wrapped command.

Each MCP tool accepts `cwd` or `portFile`. If neither is supplied, the server uses `CONSOLE_MONITOR_WORKSPACE` and then its own `process.cwd()`.

Example MCP config:

```json
{
  "mcpServers": {
    "console-monitor": {
      "command": "npx",
      "args": ["-y", "@focus.matters/console-monitor", "mcp"],
      "env": {
        "CONSOLE_MONITOR_WORKSPACE": "/absolute/path/to/project"
      }
    }
  }
}
```

## About workspace detection

An MCP server does not automatically know the agent's current working directory in a portable way. It knows the working directory of the MCP process launched by the host, and some hosts may also provide workspace roots through MCP capabilities. For this package, the reliable contract is explicit: pass `cwd`, configure `CONSOLE_MONITOR_WORKSPACE`, or pass `portFile`.
