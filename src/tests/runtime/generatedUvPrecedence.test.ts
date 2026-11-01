// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { jest } from "@jest/globals";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Shell } from "../../utils/shell.js";

test("explicit local definitions override generated definitions", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "inshellisense-spec-precedence-"));
  try {
    await fs.writeFile(path.join(directory, "package.json"), '{"type":"module"}');
    await fs.writeFile(path.join(directory, "index.js"), 'export default ["uv"]; export const diffVersionedCompletions = [];');
    await fs.writeFile(path.join(directory, "uv.js"), 'export default {name:"uv",subcommands:[{name:"from-local"}]};');
    jest.unstable_mockModule("../../runtime/generatedUv.js", () => ({
      refreshUvSpecs: async () => ({ cache: { specs: { uv: { name: "uv", subcommands: [{ name: "from-generated" }] } } } }),
    }));
    const { getConfig } = await import("../../utils/config.js");
    getConfig().specs = { path: [directory], generate: ["uv"] };
    const runtime = await import("../../runtime/runtime.js");
    await runtime.loadLocalSpecsSet();
    const result = await runtime.getSuggestions("uv ", directory, "bash" as Shell);
    expect(result?.suggestions.map((suggestion) => suggestion.name)).toContain("from-local");
    expect(result?.suggestions.map((suggestion) => suggestion.name)).not.toContain("from-generated");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
