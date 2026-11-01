// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseUvHelp, refreshUvSpecs } from "../../runtime/generatedUv.js";

const rootHelp = `An extremely fast Python package manager.

Usage: uv [OPTIONS] <COMMAND>

Commands:
  run    Run a command or script
  pip    Manage Python packages
  tool   Run and install tools
  help   Display documentation

Global options:
      --color <COLOR>  Control output [possible values: auto, always, never]
  -q, --quiet...      Use quiet output
`;

const installHelp = `Install packages

Arguments:
  [PACKAGE]...  Packages to install

Options:
  -r, --requirements <REQUIREMENTS>
          Read packages from this file [env: UV_REQUIREMENTS=]
      --directory <DIRECTORY>  Change working directory
`;

test("parses aliases, repeated flags, enum values and file arguments", () => {
  const root = parseUvHelp(rootHelp, "uv");
  expect(root.commands).toEqual(["run", "pip", "tool"]);
  expect(root.spec.options).toContainEqual({
    name: ["-q", "--quiet"],
    description: "Use quiet output",
    isRepeatable: true,
  });
  expect(root.spec.options?.[0].args).toMatchObject({ suggestions: ["auto", "always", "never"] });
  const install = parseUvHelp(installHelp, "install");
  expect(install.spec.args).toMatchObject({ name: "package", isOptional: true, isVariadic: true });
  expect(install.spec.options?.[0]).toMatchObject({
    name: ["-r", "--requirements"],
    description: "Read packages from this file",
    args: { template: "filepaths" },
  });
  expect(install.spec.options?.[1].args).toMatchObject({ template: "folders" });
});

test("reads uv tool run's positional command from Usage when Arguments is absent", () => {
  const { spec } = parseUvHelp(
    `Run a command provided by a Python package.

Usage: uv tool run [OPTIONS] [COMMAND]

Options:
      --from <FROM>  Use the given package to provide the command
`,
    "run",
  );
  expect(spec.args).toMatchObject({ name: "command", isOptional: true, isVariadic: true, template: "filepaths" });
});

test("keeps wrapped command descriptions and excludes the help footer", () => {
  const { spec, commands } = parseUvHelp(
    `Example

Commands:
  long-command
          A description on the next line

Options:
  -V, --version  Display the version

Use uv help for more details.
`,
    "uv",
  );
  expect(commands).toEqual(["long-command"]);
  expect(spec.options?.[0].description).toBe("Display the version");
});

describe("refreshUvSpecs", () => {
  let directory: string;
  let file: string;
  let version: string;
  let executable: string;
  let failHelp: boolean;
  let calls: string[][];
  const deps = {
    resolve: async () => executable,
    run: async (_executable: string, args: string[]) => {
      calls.push(args);
      if (args[0] === "--version") return version;
      if (failHelp) throw new Error("help timed out");
      const command = args.slice(0, -1).join(" ");
      const fixtures: Record<string, string> = {
        "": rootHelp,
        run: "Run a command\n\nOptions:\n      --no-sync  Skip synchronization\n",
        pip: "Manage packages\n\nCommands:\n  install  Install packages\n",
        "pip install": installHelp,
        tool: "Manage tools\n\nCommands:\n  run  Run a tool\n",
        "tool run": "Run a tool\n\nUsage: uv tool run [OPTIONS] [COMMAND]\n\nOptions:\n      --from <FROM>  Tool package\n",
      };
      if (!(command in fixtures)) throw new Error(`Unexpected command: ${command}`);
      return fixtures[command];
    },
  };

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "inshellisense-uv-"));
    file = path.join(directory, "generated", "uv.json");
    version = "uv 0.13.6";
    executable = path.join(directory, "uv");
    failHelp = false;
    calls = [];
  });

  afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });

  test("generates nested uv and uvx definitions using only help and version", async () => {
    const result = await refreshUvSpecs(file, false, deps);
    expect(result.updated).toBe(true);
    expect(result.cache.specs.uv.subcommands?.map((command) => command.name)).toEqual(["run", "pip", "tool"]);
    expect(result.cache.specs.uvx).toMatchObject({ name: "uvx", options: [{ name: "--from" }] });
    expect(result.cache.specs.uvx.args).toMatchObject({ template: "filepaths", isVariadic: true });
    expect(calls.every((args) => args.join(" ") === "--version" || args.at(-1) === "--help")).toBe(true);
    expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual(result.cache);
    expect(await fs.readdir(path.dirname(file))).toEqual(["uv.json"]);
  });

  test("checks only the version when the executable and version are unchanged", async () => {
    await refreshUvSpecs(file, false, deps);
    calls = [];
    expect((await refreshUvSpecs(file, false, deps)).updated).toBe(false);
    expect(calls).toEqual([["--version"]]);
  });

  test("regenerates after an upgrade or a change of executable path", async () => {
    await refreshUvSpecs(file, false, deps);
    version = "uv 0.13.7";
    expect((await refreshUvSpecs(file, false, deps)).cache.version).toBe(version);
    executable = path.join(directory, "another", "uv");
    expect((await refreshUvSpecs(file, false, deps)).updated).toBe(true);
  });

  test("supports an explicit refresh without a version change", async () => {
    await refreshUvSpecs(file, false, deps);
    calls = [];
    expect((await refreshUvSpecs(file, true, deps)).updated).toBe(true);
    expect(calls).toContainEqual(["tool", "run", "--help"]);
  });

  test("keeps the last working cache when help generation fails", async () => {
    await refreshUvSpecs(file, false, deps);
    const previous = await fs.readFile(file, "utf8");
    version = "uv 0.13.7";
    failHelp = true;
    const result = await refreshUvSpecs(file, false, deps);
    expect(result.warning).toContain("help timed out");
    expect(result.cache.version).toBe("uv 0.13.6");
    expect(await fs.readFile(file, "utf8")).toBe(previous);
  });

  test("keeps cached definitions when uv is temporarily unavailable", async () => {
    await refreshUvSpecs(file, false, deps);
    const result = await refreshUvSpecs(file, false, {
      ...deps,
      resolve: async () => {
        throw new Error("uv not found");
      },
    });
    expect(result.warning).toBe("uv not found");
    expect(result.cache.specs.uvx.name).toBe("uvx");
  });

  test("rejects an unrecognized help format without publishing a cache", async () => {
    await expect(
      refreshUvSpecs(file, false, { ...deps, run: async (_exe, args) => (args[0] === "--version" ? version : "Unrecognized help") }),
    ).rejects.toThrow("Could not parse");
    await expect(fs.readFile(file, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
