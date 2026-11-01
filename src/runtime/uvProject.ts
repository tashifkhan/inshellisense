// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import toml from "toml";
import { Shell } from "../utils/shell.js";

const projectDisabled = ["--no-project", "--script", "--gui-script", "-s", "--module", "-m"];
const expandHome = (value: string): string => (value === "~" ? os.homedir() : value.startsWith("~/") ? path.join(os.homedir(), value.slice(2)) : value);

const uvDirectories = (cwd: string, tokens: string[]): { working: string; project: string } | undefined => {
  let working = cwd;
  let project: string | undefined;
  for (let index = 1; index < tokens.length; index++) {
    const [option, inlineValue] = tokens[index].split(/=(.*)/s);
    if (!["--project", "--directory"].includes(option)) continue;
    const value = inlineValue ?? tokens[++index];
    if (!value) return;
    if (option === "--project") project = expandHome(value);
    else working = path.resolve(working, expandHome(value));
  }
  return { working, project: project ? path.resolve(working, project) : working };
};

const fileCache = new Map<string, { modified: number; generated: number; suggestions: Fig.Suggestion[] }>();

const quoteProject = (value: string, shell: Shell): string | undefined => {
  // The command parser does not yet support concatenated shell quotes. Keep
  // those directories available through normal --project path completion.
  if (value.includes("'")) return;
  if (shell === Shell.Fish && value.includes("\\")) return;
  if ([Shell.Zsh, Shell.Bash, Shell.Fish, Shell.Pwsh, Shell.Powershell].includes(shell)) return `'${value}'`;
  // Other shells still offer normal directory completion for --project.
};

/** List runnable files and adjacent projects without inspecting or executing their code. */
export const getUvRunFiles = async (cwd: string, shell: Shell, includeProjects = true): Promise<Fig.Suggestion[]> => {
  try {
    const key = JSON.stringify([cwd, shell, includeProjects]);
    const modified = (await fs.stat(cwd)).mtimeMs;
    const previous = fileCache.get(key);
    if (previous?.modified === modified && Date.now() - previous.generated < 1000) return previous.suggestions;
    const entries = await fs.readdir(cwd, { withFileTypes: true });
    const suggestions: Fig.Suggestion[] = [];
    // Avoid queuing thousands of filesystem operations at once in large repos.
    for (let offset = 0; offset < entries.length; offset += 16) {
      const results = await Promise.all(
        entries.slice(offset, offset + 16).map(async (entry): Promise<Fig.Suggestion[]> => {
          try {
            const file = path.join(cwd, entry.name);
            const stat = await fs.stat(file);
            const python = /\.pyw?$/i.test(entry.name);
            const runnable = stat.isFile() && (python || (stat.mode & 0o111) !== 0);
            const result: Fig.Suggestion[] =
              stat.isFile() || stat.isDirectory()
                ? [
                    {
                      name: entry.name,
                      description: runnable ? (python ? "Python script" : "Executable file") : undefined,
                      type: stat.isDirectory() ? "folder" : "file",
                      // Executables in the current directory need an explicit path.
                      insertValue: runnable && !python ? `.${path.sep}${entry.name}` : entry.name,
                      priority: runnable ? 70 : 55,
                    },
                  ]
                : [];
            if (includeProjects && !entry.name.startsWith(".") && stat.isDirectory()) {
              const quoted = quoteProject(file, shell);
              if (quoted && (await fs.stat(path.join(file, "pyproject.toml")).catch(() => undefined))?.isFile())
                result.push({
                  name: `${entry.name} [project]`,
                  description: "Choose this project's commands",
                  insertValue: `--project ${quoted} `,
                  type: "arg",
                  priority: 65,
                });
            }
            return result;
          } catch {
            // Unreadable files and broken links should not interrupt completion.
            return [];
          }
        }),
      );
      suggestions.push(...results.flat());
    }
    if (fileCache.size >= 32) fileCache.delete(fileCache.keys().next().value as string);
    fileCache.set(key, { modified, generated: Date.now(), suggestions });
    return suggestions;
  } catch {
    return [];
  }
};

/** Read entry points as data. Never import the project or run uv to discover them. */
export const getUvProjectScripts = async (cwd: string, tokens: string[]): Promise<Fig.Suggestion[]> => {
  if (tokens.some((token) => projectDisabled.includes(token))) return [];
  const directories = uvDirectories(cwd, tokens);
  if (!directories) return [];
  let directory = directories.project;
  if (!(await fs.stat(directory).catch(() => undefined))?.isDirectory()) return [];

  for (;;) {
    const file = path.join(directory, "pyproject.toml");
    try {
      // Bound work on each keystroke, including accidental non-project files.
      const stat = await fs.stat(file);
      if (!stat.isFile() || stat.size > 1024 * 1024) return [];
      const data = toml.parse(await fs.readFile(file, "utf8"));
      const scripts = data.project?.scripts;
      if (scripts == null || typeof scripts !== "object" || Array.isArray(scripts)) return [];
      return Object.entries(scripts)
        .filter(([name, target]) => /^[\w][\w.-]*$/.test(name) && typeof target === "string")
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, target]) => ({ name, description: `Project script: ${target}`, priority: 75, type: "arg" }));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return [];
    }
    const parent = path.dirname(directory);
    if (parent === directory) return [];
    directory = parent;
  }
};

/** Attach live project discovery after loading JSON definitions, outside the version cache. */
export const withUvProjectScripts = (uv: Fig.Subcommand, shell = Shell.Bash): Fig.Subcommand => ({
  ...uv,
  subcommands: uv.subcommands?.map((command) => {
    if (command.name !== "run" || !command.args) return command;
    const args = Array.isArray(command.args) ? command.args : [command.args];
    const [first, ...remaining] = args;
    if (!first) return command;
    const existing = first.generators == null ? [] : Array.isArray(first.generators) ? first.generators : [first.generators];
    const options = [...(uv.options ?? []), ...(command.options ?? [])];
    const isFileArgument = (tokens: string[]): boolean => {
      let afterRun = false;
      let afterSeparator = false;
      for (let index = 1; index < tokens.length; index++) {
        const token = tokens[index];
        if (!afterRun && token === "run") {
          afterRun = true;
          continue;
        }
        if (token === "--") {
          afterSeparator = true;
          continue;
        }
        if (!afterSeparator && token.startsWith("-")) {
          const name = token.split("=")[0];
          const option = options.find((option) => (Array.isArray(option.name) ? option.name : [option.name]).includes(name));
          if (option?.args && !token.includes("=")) index++;
          continue;
        }
        if (afterRun) return /[/\\]/.test(token) || token.startsWith(".") || token.startsWith("~");
      }
      return false;
    };
    return {
      ...command,
      args: [
        {
          ...first,
          template: first.template === "filepaths" ? undefined : first.template,
          isVariadic: false,
          filterStrategy: first.filterStrategy ?? "fuzzy",
          generators: [
            ...existing,
            {
              cache: { strategy: "max-age", ttl: -1, cacheByDirectory: true },
              custom: async (tokens, _execute, context) => {
                if (tokens.some((token) => ["--module", "-m"].includes(token))) return [];
                const directories = uvDirectories(context.currentWorkingDirectory, tokens);
                if (!directories) return [];
                return [
                  ...(isFileArgument(tokens) ? [] : await getUvProjectScripts(context.currentWorkingDirectory, tokens)),
                  ...(await getUvRunFiles(directories.working, shell, !tokens.some((token) => projectDisabled.includes(token)))),
                ];
              },
            },
          ],
        },
        ...(first.isVariadic ? [{ name: "args", isOptional: true, isVariadic: true, template: "filepaths" as const }] : []),
        ...remaining,
      ],
    };
  }),
});
