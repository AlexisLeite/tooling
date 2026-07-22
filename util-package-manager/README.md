# @focus.matters/upm

Utility package manager for agent resources published by npm packages.

## Usage

```bash
upm init
upm install @focus.matters/console-monitor
upm update
```

`upm init` writes `upm.json` in the current directory. All other commands require that file.

`upm install <package>` reads the package metadata from npm first. It downloads the package tarball only when selected resources need package files, such as commands, binaries, skills, manuals, or hooks. MCP-only installs can be written directly to `config.toml`.

Commands are installed into `.upm/bin` under the current project. Add that directory to PATH when you want to invoke installed commands directly.

## Package resources

Packages declare resources in their `util-package` key:

- `commands`: Node commands with a shim in `.upm/bin`.
- `binaries`: executables copied directly to `.upm/bin`.
- `mcpServers`: managed blocks in `config.toml`.
- `skills`: folders installed under the configured skills directory.
- `manuals`: documents copied into the project.
- `hooks`: Codex handlers. UPM copies the script to Codex's global directory and merges its entry into `hooks.json` without replacing existing hooks.

A package may declare `postInstall`. Each script runs after installation or update and receives `UPM_PACKAGE_DIR`, `UPM_PACKAGE_NAME`, `UPM_PACKAGE_VERSION`, and `UPM_CODEX_HOME` in its environment.
