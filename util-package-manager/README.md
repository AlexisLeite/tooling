# @focus.matters/upm

Utility package manager for agent resources published by npm packages.

## Usage

```bash
upm init
upm install @focus.matters/console-monitor
upm update
```

`upm init` writes `upm.json` in the current directory. All other commands require that file.

`upm install <package>` reads the package metadata from npm first. It downloads the package tarball only when selected resources need package files, such as commands, skills, or manuals. MCP-only installs can be written directly to `config.toml`.

Commands are installed into `.upm/bin` under the current project. Add that directory to PATH when you want to invoke installed commands directly.
