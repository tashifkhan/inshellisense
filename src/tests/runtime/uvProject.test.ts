// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { jest } from "@jest/globals";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getUvProjectScripts, getUvRunFiles, withUvProjectScripts } from "../../runtime/uvProject.js";
import { Shell } from "../../utils/shell.js";

const uv: Fig.Subcommand = {
  name: "uv",
  options: [{ name: "--directory", args: { name: "directory" }, isPersistent: true }],
  subcommands: [
    {
      name: "run",
      args: { name: "command", isOptional: true, isVariadic: true, template: "filepaths" },
      options: [
        { name: "--extra", args: { name: "extra" } },
        { name: "--project", args: { name: "project" } },
        { name: "--no-project" },
        { name: ["--script", "-s"] },
        { name: "--gui-script" },
        { name: ["--module", "-m"] },
        { name: ["--config-setting", "-C"], args: { name: "setting" } },
      ],
    },
  ],
};
jest.unstable_mockModule("../../runtime/generatedUv.js", () => ({
  refreshUvSpecs: async () => ({ cache: { specs: { uv, uvx: { name: "uvx" } } } }),
}));
const { getConfig } = await import("../../utils/config.js");
getConfig().specs = { path: [], generate: ["uv"] };
const { loadLocalSpecsSet, getSuggestions } = await import("../../runtime/runtime.js");
await loadLocalSpecsSet();

let directory: string;
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "inshellisense-uv-project-"));
  await fs.writeFile(path.join(directory, "pyproject.toml"), '[project.scripts]\ncpsdev = "app:main"\ninfra_manager = "infra:main"\n');
});
afterEach(async () => {
  await fs.rm(directory, { recursive: true, force: true });
});
const names = async (command: string, cwd = directory) =>
  (await getSuggestions(command, cwd, "zsh" as Shell))?.suggestions.map((suggestion) => suggestion.name) ?? [];

test("puts project scripts before options, filters prefixes, and retains file suggestions", async () => {
  await fs.writeFile(path.join(directory, "script.py"), "");
  const suggestions = await names("uv run ");
  expect(suggestions.slice(0, 2)).toEqual(["cpsdev", "infra_manager"]);
  expect(suggestions).toContain("--extra");
  expect(suggestions).toContain("script.py");
  expect(await names("uv run cps")).toContain("cpsdev");
  expect(await names("uv run infra")).toContain("infra_manager");
  expect(await names("uv run --extra web ")).toContain("cpsdev");
  expect(await names("uv run cpsdev ")).not.toContain("infra_manager");
  expect(await names("uv run cpsdev infra")).not.toContain("infra_manager");
  await fs.mkdir(path.join(directory, "scripts"));
  await fs.writeFile(path.join(directory, "scripts", "nested.py"), "");
  expect(await names("uv run scripts/")).toContain("nested.py");
  expect(await names("uv run scripts/")).not.toContain("cpsdev");
});

test("prioritizes runnable files and quotes project selections without executing files", async () => {
  await fs.writeFile(path.join(directory, "start.py"), "raise RuntimeError('do not execute')");
  await fs.writeFile(path.join(directory, "run local"), "do not execute", { mode: 0o755 });
  await fs.writeFile(path.join(directory, "notes.txt"), "not runnable");
  const project = "a project $example";
  await fs.mkdir(path.join(directory, project));
  await fs.writeFile(path.join(directory, project, "pyproject.toml"), '[project.scripts]\nother = "app:main"');
  const suggestions = (await getSuggestions("uv run ", directory, Shell.Zsh))?.suggestions ?? [];
  const resultNames = suggestions.map((s) => s.name);
  expect(resultNames.indexOf("start.py")).toBeLessThan(resultNames.indexOf("notes.txt"));
  expect(resultNames.indexOf("run local")).toBeLessThan(resultNames.indexOf("notes.txt"));
  expect(suggestions.find((s) => s.name === "run local")?.insertValue).toBe('"./run local"');
  const selection = suggestions.find((s) => s.name === `${project} [project]`);
  expect(selection?.insertValue).toBe(`--project '${path.join(directory, project)}' `);
  expect(selection?.insertValue).toContain("$example");
  expect(await names(`uv run ${selection?.insertValue}`)).toContain("other");
  expect(await names("uv run --no-project ")).not.toContain(`${project} [project]`);
  expect((await getUvRunFiles(directory, Shell.Pwsh)).find((s) => s.name === `${project} [project]`)?.insertValue).toBe(selection?.insertValue);
  const quotedProject = "project's";
  await fs.mkdir(path.join(directory, quotedProject));
  await fs.writeFile(path.join(directory, quotedProject, "pyproject.toml"), "");
  expect((await getUvRunFiles(directory, Shell.Zsh)).some((s) => s.name === `${quotedProject} [project]`)).toBe(false);
});

test("reads edits and directory changes without recreating the runtime or uv version cache", async () => {
  expect(await names("uv run ")).toContain("cpsdev");
  await fs.writeFile(path.join(directory, "pyproject.toml"), '[project.scripts]\nnewcmd = "new:main"');
  expect(await names("uv run ")).toContain("newcmd");
  expect(await names("uv run ")).not.toContain("cpsdev");
  const child = path.join(directory, "src");
  await fs.mkdir(child);
  expect(await names("uv run ", child)).toContain("newcmd");
  await fs.writeFile(path.join(child, "pyproject.toml"), '[project.scripts]\nchild = "child:main"');
  expect(await names("uv run ", child)).toContain("child");
  expect(await names("uv run ", child)).not.toContain("newcmd");
});

test("honors project selection and suppresses scripts when project discovery is disabled", async () => {
  const child = path.join(directory, "other project");
  await fs.mkdir(child);
  await fs.writeFile(path.join(child, "pyproject.toml"), '[project.scripts]\nother = "other:main"');
  expect(await names('uv run --project "other project" ')).toContain("other");
  expect(await names('uv --directory "other project" run ')).toContain("other");
  expect((await getUvProjectScripts(directory, ["uv", "--directory", "other project", "run"])).map((s) => s.name)).toEqual(["other"]);
  expect(await names("uv run -C backend=value ")).toContain("cpsdev");
  expect((await getUvProjectScripts(directory, ["uv", "run", "--project=other project"])).map((s) => s.name)).toEqual(["other"]);
  for (const flag of ["--no-project", "--script", "--gui-script", "-s", "--module", "-m"]) {
    expect(await names(`uv run ${flag} `)).not.toContain("cpsdev");
  }
});

test("uses the selected working directory for runnable files and excludes module mode", async () => {
  await fs.writeFile(path.join(directory, "root.py"), "");
  await fs.mkdir(path.join(directory, "child"));
  await fs.writeFile(path.join(directory, "child", "child.py"), "");
  const result = await names("uv --directory child run ");
  expect(result).toContain("child.py");
  expect(result).not.toContain("root.py");
  expect(await names("uv run -m ")).not.toContain("root.py");
  expect(await names("uv run --module ")).not.toContain("root.py");
});

test("does not fall back from missing directory overrides and expands home paths", async () => {
  expect(await getUvProjectScripts(directory, ["uv", "run", "--project", "missing"])).toEqual([]);
  expect(await getUvProjectScripts(directory, ["uv", "--directory", "missing", "run"])).toEqual([]);
  const home = jest.spyOn(os, "homedir").mockReturnValue(directory);
  try {
    expect(await getUvProjectScripts("/", ["uv", "run", "--project", "~/"])).toEqual(expect.arrayContaining([expect.objectContaining({ name: "cpsdev" })]));
    expect(await getUvProjectScripts("/", ["uv", "--directory", "~", "run"])).toEqual(expect.arrayContaining([expect.objectContaining({ name: "cpsdev" })]));
  } finally {
    home.mockRestore();
  }
});

test("handles missing, malformed, oversized, and non-script project files without executing entry points", async () => {
  const file = path.join(directory, "pyproject.toml");
  for (const contents of ["[", '[project]\nname = "empty"', "[project.scripts]\nbad = 3", "#".repeat(1024 * 1024 + 1)]) {
    await fs.writeFile(file, contents);
    expect(await getUvProjectScripts(directory, ["uv", "run"])).toEqual([]);
  }
  await fs.rm(file);
  expect(await getUvProjectScripts(directory, ["uv", "run"])).toEqual([]);
  // The target does not exist. Completion must never resolve or import it.
  await fs.writeFile(file, '[project.scripts]\nsafe = "nonexistent_dangerous_module:main"');
  expect(await getUvProjectScripts(directory, ["uv", "run"])).toMatchObject([{ name: "safe" }]);
});

test("attaches live discovery without mutating serializable cached definitions", () => {
  const before = JSON.stringify(uv);
  const enhanced = withUvProjectScripts(uv);
  expect(JSON.stringify(uv)).toBe(before);
  expect(enhanced.subcommands?.[0].args).toHaveLength(2);
  expect(() => withUvProjectScripts({ name: "uv", subcommands: [{ name: "run", args: [] }] })).not.toThrow();
});
