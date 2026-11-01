// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { jest } from "@jest/globals";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";

let directory: string;
let previousConfigHome: string | undefined;

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "inshellisense-generated-config-"));
  previousConfigHome = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = directory;
  await fs.mkdir(path.join(directory, "inshellisense"));
});

afterEach(async () => {
  if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = previousConfigHome;
  jest.restoreAllMocks();
  await fs.rm(directory, { recursive: true, force: true });
});

test.each([true, false])("validates the opt-in generator list, valid=%s", async (valid) => {
  await fs.writeFile(path.join(directory, "inshellisense/rc.toml"), `[specs]\ngenerate = ["${valid ? "uv" : "unknown"}"]\n`);
  await jest.isolateModulesAsync(async () => {
    const { loadConfig, getConfig } = await import("../../utils/config.js");
    const command = new Command().exitOverride().configureOutput({ writeErr: () => {} });
    if (valid) {
      await loadConfig(command);
      expect(getConfig().specs.generate).toEqual(["uv"]);
    } else {
      await expect(loadConfig(command)).rejects.toThrow("invalid");
    }
  });
});

test("reports a missing executable through the command error handler", async () => {
  await jest.isolateModulesAsync(async () => {
    jest.unstable_mockModule("../../runtime/generatedUv.js", () => ({
      refreshUvSpecs: async () => {
        throw new Error("uv not found");
      },
    }));
    const { default: command } = await import("../../commands/specs/refresh.js");
    let output = "";
    command.exitOverride().configureOutput({
      writeErr: (text) => {
        output += text;
      },
    });
    await expect(command.parseAsync(["node", "refresh", "uv"])).rejects.toThrow("Could not generate uv completions: uv not found");
    expect(output).not.toContain(" at ");
  });
});

test("returns an empty JSON result for an unsupported command", async () => {
  await jest.isolateModulesAsync(async () => {
    jest.unstable_mockModule("../../runtime/initialize.js", () => ({
      initializeRuntime: async () => ({ getSuggestions: async () => undefined }),
    }));
    const { default: command } = await import("../../commands/complete.js");
    let output = "";
    jest.spyOn(process.stdout, "write").mockImplementation((text) => {
      output += text;
      return true;
    });
    jest.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`exit ${code}`);
    });
    await expect(command.parseAsync(["node", "complete", "unsupported "])).rejects.toThrow("exit 0");
    expect(JSON.parse(output)).toEqual({ suggestions: [] });
  });
});
