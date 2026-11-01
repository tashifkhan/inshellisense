// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { Argument, Command } from "commander";
import { getConfig, loadConfig } from "../../utils/config.js";
import { refreshUvSpecs } from "../../runtime/generatedUv.js";

const cmd = new Command("refresh");
cmd.description("refresh completion definitions generated from installed tools");
cmd.addArgument(new Argument("[command]", "command to refresh").choices(["uv"]));
cmd.action(async (command: string | undefined) => {
  await loadConfig(cmd);
  const generators = command ? [command] : getConfig().specs.generate ?? [];
  if (!generators.length) {
    process.stdout.write('No generators enabled. Add generate = ["uv"] under [specs], or run is specs refresh uv.\n');
    return;
  }
  try {
    const { cache, warning } = await refreshUvSpecs(undefined, true);
    if (warning) cmd.error(`Could not refresh uv completions; kept the previous definitions: ${warning}`);
    process.stdout.write(`Refreshed uv and uvx completions for ${cache.version}\n`);
  } catch (error) {
    cmd.error(`Could not generate uv completions: ${error instanceof Error ? error.message : String(error)}`);
  }
});

export default cmd;
