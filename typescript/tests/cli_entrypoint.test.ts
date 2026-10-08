import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { VERSION } from "../src/version.js";

const cliPath = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.ts");

/** Run the npm `mcp-compressor` bin with no Rust binary available. */
function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const env = { ...process.env };
  delete env.MCP_COMPRESSOR_BINARY;
  return new Promise((resolve) => {
    execFile("bun", [cliPath, ...args], { env, encoding: "utf8" }, (error, stdout, stderr) => {
      const code = error ? Number((error as { code?: unknown }).code ?? 1) : 0;
      resolve({ code, stdout, stderr: stderr.replace(/\r\n/g, "\n") });
    });
  });
}

describe("npm mcp-compressor bin", () => {
  it("runs the Rust CLI in-process without a separate binary", async () => {
    const result = await runCli(["--help"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Usage: mcp-compressor [OPTIONS]");
  });

  it("reports the npm package version", async () => {
    const result = await runCli(["--version"]);
    expect(result).toEqual({ code: 0, stdout: `mcp-compressor ${VERSION}\n`, stderr: "" });
  });

  it("exits 2 with a single error prefix for usage errors", async () => {
    const result = await runCli(["--bogus"]);
    expect(result.code).toBe(2);
    expect(result.stderr.startsWith("error: unexpected argument '--bogus' found\n")).toBe(true);
    expect(result.stderr).not.toContain("error: error:");
  });
});
