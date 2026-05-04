import { pathExists, writeConfig } from "../config.js";
import { defaultInitPaths, initPrompts } from "../prompts.js";

export async function initCommand() {
  const defaults = defaultInitPaths();
  const answers = await initPrompts(defaults);

  const config = {
    schemaVersion: 1,
    configTomlPath: answers.configTomlPath,
    codexPath: answers.codexPath,
    packages: {}
  };

  const writtenPath = await writeConfig(config);
  console.log(`Created ${writtenPath}`);

  if (!(await pathExists(answers.configTomlPath))) {
    console.log(`Warning: config.toml does not exist yet: ${answers.configTomlPath}`);
  }

  if (!(await pathExists(answers.codexPath))) {
    console.log(`Warning: .codex directory does not exist yet: ${answers.codexPath}`);
  }
}
