import { execFile, spawn } from "node:child_process";
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

  it("identifies itself to MCP clients with the npm package version", async () => {
    const env = { ...process.env };
    delete env.MCP_COMPRESSOR_BINARY;
    const fixture = join(
      dirname(cliPath),
      "..",
      "..",
      "crates",
      "mcp-compressor-core",
      "tests",
      "fixtures",
      "alpha_server.py",
    );
    const python = process.env.PYTHON ?? "python3";
    // Bun consumes the first `--` itself, so pass a second one through to the CLI.
    const child = spawn("bun", [cliPath, "--", "--", python, fixture], { env });
    try {
      const response = await new Promise<string>((resolve, reject) => {
        let buffer = "";
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
          buffer += chunk;
          const newline = buffer.indexOf("\n");
          if (newline >= 0) resolve(buffer.slice(0, newline));
        });
        child.on("error", reject);
        child.on("exit", (code) => reject(new Error(`CLI exited early with ${code}`)));
        child.stdin.write(
          `${JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
              protocolVersion: "2025-06-18",
              capabilities: {},
              clientInfo: { name: "test", version: "1" },
            },
          })}\n`,
        );
      });
      const message = JSON.parse(response) as {
        result: { serverInfo: { name: string; version: string } };
      };
      expect(message.result.serverInfo).toMatchObject({ name: "mcp-compressor", version: VERSION });
    } finally {
      child.kill();
    }
  }, 30_000);
});
