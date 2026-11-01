// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import which from "which";
import { allResourcesPath } from "../utils/constants.js";

const executeFile = promisify(execFile);
// Bump this when parser semantics or the cached definition format changes.
const cacheFormat = 1;
export const uvCachePath = path.join(allResourcesPath, "generated-specs", "uv.json");

type Cache = {
  format: number;
  executable: string;
  version: string;
  specs: { uv: Fig.Subcommand; uvx: Fig.Subcommand };
};

type Dependencies = {
  resolve: () => Promise<string>;
  run: (executable: string, args: string[]) => Promise<string>;
};

const dependencies: Dependencies = {
  resolve: () => which("uv"),
  run: async (executable, args) => {
    const { stdout } = await executeFile(executable, args, {
      cwd: os.tmpdir(),
      env: { ...process.env, NO_COLOR: "1", UV_NO_CONFIG: "1", COLUMNS: "160" },
      timeout: 3_000,
      maxBuffer: 1024 * 1024,
      encoding: "utf8",
      windowsHide: true,
    });
    return stdout;
  },
};

const argument = (name: string, description: string, optional: boolean, variadic = false): Fig.Arg => {
  const result: Fig.Arg = { name: name.toLowerCase().replaceAll("_", "-"), isOptional: optional, isVariadic: variadic };
  if (["DIRECTORY", "DIR", "CACHE_DIR", "PROJECT", "PREFIX", "TARGET"].includes(name)) {
    result.template = "folders";
  } else if (/FILE|PATH|REQUIREMENTS|CONSTRAINTS|OVERRIDES|EDITABLE|SCRIPT/.test(name)) {
    result.template = "filepaths";
  }
  const choices = description.match(/\[possible values:\s*([^\]]+)\]/)?.[1];
  if (choices) result.suggestions = choices.split(",").map((choice) => choice.trim());
  return result;
};

/** Parse uv's concise help without running the command being described. */
export const parseUvHelp = (text: string, name: string): { spec: Fig.Subcommand; commands: string[] } => {
  const entries: { section: string; signature: string; description: string }[] = [];
  let section = "";
  let current: (typeof entries)[number] | undefined;
  for (const line of text.split(/\r?\n/)) {
    if (/^\S.*:$/.test(line)) {
      section = line.slice(0, -1);
      current = undefined;
      continue;
    }
    const entry =
      (section === "Commands" && /^ {2}[a-z][a-z0-9-]*(?:\s{2,}|$)/.test(line)) ||
      (section === "Arguments" && /^ {2}(?:<|\[)/.test(line)) ||
      (section !== "Commands" && /^ {2,6}-\S/.test(line));
    if (entry) {
      const [signature, ...description] = line.trim().split(/\s{2,}/);
      current = { section, signature, description: description.join(" ") };
      entries.push(current);
    } else if (line && !line.startsWith(" ")) {
      current = undefined;
    } else if (current && line.trim()) {
      current.description += " " + line.trim();
    }
  }

  const spec: Fig.Subcommand = { name, description: text.trim().split(/\r?\n/)[0], options: [] };
  const args: Fig.Arg[] = [];
  const commands: string[] = [];
  for (const entry of entries) {
    const { section, signature } = entry;
    const description = entry.description.replace(/\s*\[env:[^\]]*\]/g, "").trim();
    if (section === "Commands") {
      const command = signature.split(" ")[0];
      if (command !== "help") commands.push(command);
    } else if (section === "Arguments") {
      const match = signature.match(/^[<[]([A-Z][A-Z0-9_-]*)[>\]](\.\.\.)?/);
      if (match) args.push(argument(match[1], description, signature.startsWith("["), !!match[2]));
    } else {
      const names = signature.match(/--[a-zA-Z0-9][a-zA-Z0-9-]*|-[a-zA-Z?]/g);
      if (!names) continue;
      const option: Fig.Option = { name: names.length === 1 ? names[0] : names, description };
      const value = signature.match(/<([A-Z][A-Z0-9_-]*)>/)?.[1];
      if (value) option.args = argument(value, description, false);
      if (signature.includes("...") || description.includes("more than once")) option.isRepeatable = true;
      spec.options?.push(option);
    }
  }
  // clap may put positional arguments only in Usage, notably for uv run/tool run.
  if (!args.length) {
    const usage = text.match(/^Usage: (.+)$/m)?.[1] ?? "";
    for (const match of usage.matchAll(/(\[|<)([A-Z][A-Z0-9_-]*)[>\]](\.\.\.)?/g)) {
      if (match[2] === "OPTIONS" || (match[2] === "COMMAND" && commands.length)) continue;
      const arg = argument(match[2], "", match[1] === "[", !!match[3]);
      if (match[2] === "COMMAND") {
        arg.template = "filepaths";
        arg.isVariadic = true;
      }
      args.push(arg);
    }
  }
  if (args.length) spec.args = args.length === 1 ? args[0] : args;
  return { spec, commands };
};

const readCache = async (file: string): Promise<Cache | undefined> => {
  try {
    const cache: Cache = JSON.parse(await fs.readFile(file, "utf8"));
    if (
      cache.format === cacheFormat &&
      typeof cache.executable === "string" &&
      typeof cache.version === "string" &&
      cache.specs?.uv?.name === "uv" &&
      cache.specs?.uvx?.name === "uvx"
    ) {
      return cache;
    }
  } catch {
    // A missing or malformed cache is regenerated when uv is available.
  }
};

/** Reuse cached definitions until uv's executable path or version changes. */
export const refreshUvSpecs = async (
  file = uvCachePath,
  force = false,
  deps: Dependencies = dependencies,
): Promise<{ cache: Cache; updated: boolean; warning?: string }> => {
  const previous = await readCache(file);
  try {
    const executable = await deps.resolve();
    const version = (await deps.run(executable, ["--version"])).trim();
    if (!/^uv\s+\S+/.test(version)) throw new Error("uv returned an invalid version");
    if (!force && previous?.executable === executable && previous.version === version) {
      return { cache: previous, updated: false };
    }

    let count = 0;
    const deadline = Date.now() + 15_000;
    const generate = async (parts: string[]): Promise<Fig.Subcommand> => {
      if (Date.now() > deadline || ++count > 200 || parts.length > 5) throw new Error("uv help exceeded the completion generation limit");
      const { spec, commands } = parseUvHelp(await deps.run(executable, [...parts, "--help"]), parts.at(-1) ?? "uv");
      if (commands.length) {
        // Bound process creation rather than spawning every help command at once.
        spec.subcommands = [];
        for (const command of commands) spec.subcommands.push(await generate([...parts, command]));
      }
      return spec;
    };
    const uv = await generate([]);
    if (!uv.subcommands?.length) throw new Error("Could not parse uv's command list");
    const tool = uv.subcommands.find((command) => command.name === "tool");
    const run = tool?.subcommands?.find((command) => command.name === "run");
    if (!run) throw new Error("Could not find uv tool run in the generated definitions");
    const uvx: Fig.Subcommand = { ...run, name: "uvx" };
    const cache: Cache = { format: cacheFormat, executable, version, specs: { uv, uvx } };

    await fs.mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify(cache), { mode: 0o600 });
      await fs.rename(temporary, file);
    } finally {
      await fs.rm(temporary, { force: true });
    }
    return { cache, updated: true };
  } catch (error) {
    if (previous) return { cache: previous, updated: false, warning: error instanceof Error ? error.message : String(error) };
    throw error;
  }
};
