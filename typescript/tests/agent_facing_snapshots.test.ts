import { execFile, execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Bash } from "just-bash";
import { describe, expect, it } from "vitest";

import { compressTools } from "../src/local_tools.js";
import {
  transformToolsForCliMode,
  transformToolsForCodeMode,
  transformToolsForJustBash,
} from "../src/transforms.js";
import type { ExecutableTool } from "../src/adapters.js";

const alphaTools: Record<string, ExecutableTool<unknown>> = {
  echo: {
    name: "echo",
    description: "Echo a message.",
    inputSchema: {
      type: "object",
      properties: { message: { type: "string", description: "Message to echo" } },
      required: ["message"],
    },
    execute: async (input = {}) => `alpha:${String((input as { message?: unknown }).message)}`,
  },
  add: {
    name: "add",
    description: "Add two integers.",
    inputSchema: {
      type: "object",
      properties: {
        a: { type: "integer", description: "Left operand" },
        b: { type: "integer", description: "Right operand" },
      },
      required: ["a", "b"],
    },
    execute: async (input = {}) =>
      Number((input as { a?: unknown }).a) + Number((input as { b?: unknown }).b),
  },
  summarize_payload: {
    name: "summarize_payload",
    description: "Summarize a structured payload.",
    inputSchema: {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: { type: "string" },
          description: "Items to summarize",
        },
        metadata: { type: "object", description: "Arbitrary metadata" },
        include_details: { type: "boolean", description: "Include detailed rows" },
      },
      required: ["items"],
    },
    execute: async (input = {}) => ({
      itemCount: Array.isArray((input as { items?: unknown }).items)
        ? (input as { items: unknown[] }).items.length
        : 0,
      metadata: (input as { metadata?: unknown }).metadata,
      includeDetails: (input as { include_details?: unknown }).include_details ?? true,
    }),
  },
};

function normalizePaths(value: string, replacements: Record<string, string>): string {
  const replaced = Object.entries(replacements).reduce(
    (text, [actual, placeholder]) => text.split(actual).join(placeholder),
    value,
  );
  // Generated source paths use the OS separator (`\` on Windows); the goldens are
  // POSIX. Normalize the separator so these prose snapshots compare on any platform.
  return process.platform === "win32" ? replaced.split("\\").join("/") : replaced;
}

// Windows runs the `.cmd`; other platforms run the extensionless shell script.
function generatedScriptPath(outputDir: string, baseName: string): string {
  return join(outputDir, process.platform === "win32" ? `${baseName}.cmd` : baseName);
}

function runScript(scriptPath: string, args: readonly string[]): string {
  // A `.cmd` can only be launched through a shell on Windows; elsewhere the script
  // runs directly. Normalize CRLF so the snapshots compare on any platform.
  return execFileSync(scriptPath, [...args], {
    encoding: "utf8",
    shell: process.platform === "win32",
  })
    .trimEnd()
    .replace(/\r\n/g, "\n");
}

function materializeFiles(
  outputDir: string,
  files: Record<string, string>,
  executableNames: readonly string[] = [],
): void {
  mkdirSync(outputDir, { recursive: true });
  for (const [name, contents] of Object.entries(files)) {
    const path = join(outputDir, name);
    writeFileSync(path, contents);
    if (executableNames.includes(name)) {
      chmodSync(path, 0o755);
    }
  }
}

function golden(relativePath: string): string {
  // A Windows checkout may store these goldens with CRLF; normalize to LF so they
  // compare against the LF-normalized script output on any platform.
  return readFileSync(join(process.cwd(), "..", "testdata", "golden", relativePath), "utf8")
    .trimEnd()
    .replace(/\r\n/g, "\n");
}

function toStableJson(value: unknown): string {
  return JSON.stringify(value, Object.keys(value as Record<string, unknown>).sort(), 2);
}

describe("agent-facing alpha snapshots", () => {
  it("snapshots CLI command help and invocation output for host-owned tools", async () => {
    const outputDir = mkdtempSync(join(tmpdir(), "mcp-alpha-cli-snapshot-"));
    const transform = await transformToolsForCliMode(alphaTools, {
      serverName: "alpha",
      outputDir,
    });
    try {
      materializeFiles(outputDir, transform.files, ["alpha"]);
      const scriptPath = generatedScriptPath(outputDir, "alpha");
      expect(runScript(scriptPath, ["--help"])).toBe(golden("agent-facing/cli/alpha-help.txt"));
      expect(runScript(scriptPath, ["echo", "--help"])).toBe(
        golden("agent-facing/cli/alpha-echo-help.txt"),
      );
    } finally {
      transform.close();
    }
  });

  it("snapshots CLI and Just Bash help tool descriptions", async () => {
    const outputDir = mkdtempSync(join(tmpdir(), "mcp-alpha-cli-help-snapshot-"));
    const cli = await transformToolsForCliMode(alphaTools, { serverName: "alpha", outputDir });
    const bash = new Bash({ customCommands: [] });
    const justBash = transformToolsForJustBash(alphaTools, { serverName: "alpha", bash });
    try {
      const cliDescription = normalizePaths(cli.tools.alpha_help?.description ?? "", {
        [outputDir]: "<cli-dir>",
      });
      expect(cliDescription).toBe(golden("agent-facing/cli/alpha-help-tool-description.txt"));
      expect(justBash.tools.alpha_help?.description).toBe(cli.tools.alpha_help?.description);
      expect(justBash.tools.alpha_help?.description).toBe(
        golden("agent-facing/cli/alpha-help-tool-description.txt"),
      );

      const bashResult = await bash.exec("alpha echo --message snapshot");
      expect(bashResult.stdout.trimEnd()).toBe(golden("agent-facing/cli/alpha-echo-output.txt"));
    } finally {
      cli.close();
    }
  });

  it("Just Bash help has parity with generated CLI help (top-level + subcommand)", async () => {
    // Generate the CLI script so we can compare against the actual `--help`
    // outputs the shell user would see.
    const outputDir = mkdtempSync(join(tmpdir(), "mcp-alpha-parity-snapshot-"));
    const cli = await transformToolsForCliMode(alphaTools, { serverName: "alpha", outputDir });
    const bash = new Bash({ customCommands: [] });
    transformToolsForJustBash(alphaTools, { serverName: "alpha", bash });
    try {
      materializeFiles(outputDir, cli.files, ["alpha"]);
      const scriptPath = generatedScriptPath(outputDir, "alpha");

      // Top-level dispatcher help must match the generated CLI `--help` body.
      const cliTopLevel = runScript(scriptPath, ["--help"]);
      const bashTopLevel = (await bash.exec("alpha --help")).stdout.trimEnd();
      expect(bashTopLevel).toBe(cliTopLevel);

      // Per-subcommand help must be the rich help, identical to the CLI's.
      const cliSubHelp = runScript(scriptPath, ["echo", "--help"]);
      const bashSubHelp = (await bash.exec("alpha echo --help")).stdout.trimEnd();
      expect(bashSubHelp).toBe(cliSubHelp);
      // Sanity: rich subcommand help includes the USAGE + typed option, not just a one-liner.
      expect(bashSubHelp).toContain("USAGE:");
      expect(bashSubHelp).toContain("--message <string>");
    } finally {
      cli.close();
    }
  });

  it("Just Bash validates enum arguments like the generated CLI", async () => {
    const enumTools = {
      search: {
        name: "search",
        description: "Search things.",
        inputSchema: {
          type: "object",
          properties: {
            sort: {
              type: "string",
              description: "Sort order.",
              enum: ["score", "timestamp"],
            },
          },
        },
        execute: async (): Promise<unknown> => "ok",
      },
    };
    const bash = new Bash({ customCommands: [] });
    transformToolsForJustBash(enumTools, { serverName: "things", bash });
    const ok = await bash.exec("things search --sort timestamp");
    expect(ok.exitCode).toBe(0);
    const bad = await bash.exec("things search --sort nonsense");
    expect(bad.exitCode).not.toBe(0);
    expect(`${bad.stderr}${bad.stdout}`).toContain(
      "invalid value for --sort: nonsense (expected one of: score, timestamp)",
    );
  });

  it("snapshots camelCase tool and property names as kebab-case CLI affordances", async () => {
    const outputDir = mkdtempSync(join(tmpdir(), "mcp-atlassian-cli-snapshot-"));
    const transform = await transformToolsForCliMode(
      {
        searchJiraIssuesUsingJql: {
          name: "searchJiraIssuesUsingJql",
          description: "Search issues with JQL",
          inputSchema: {
            type: "object",
            properties: {
              cloudId: { type: "string", description: "Cloud ID" },
              jql: { type: "string", description: "JQL query" },
              maxResults: { type: "number", description: "Max results" },
              nextPageToken: { type: "string", description: "Page token" },
            },
            required: ["cloudId", "jql"],
          },
          execute: async (): Promise<unknown> => "ok",
        },
      },
      { serverName: "atlassian", outputDir },
    );
    try {
      materializeFiles(outputDir, transform.files, ["atlassian"]);
      const scriptPath = generatedScriptPath(outputDir, "atlassian");
      expect(runScript(scriptPath, ["--help"])).toBe(
        golden("agent-facing/atlassian-like/atlassian-help.txt"),
      );
      expect(runScript(scriptPath, ["search-jira-issues-using-jql", "--help"])).toBe(
        golden("agent-facing/atlassian-like/search-jira-issues-using-jql-help.txt"),
      );
    } finally {
      transform.close();
    }
  });

  it("snapshots Python and TypeScript code-mode help descriptions", async () => {
    const pythonDir = mkdtempSync(join(tmpdir(), "mcp-alpha-python-snapshot-"));
    const tsDir = mkdtempSync(join(tmpdir(), "mcp-alpha-ts-snapshot-"));
    const python = await transformToolsForCodeMode(alphaTools, {
      serverName: "alpha",
      language: "python",
      outputDir: pythonDir,
    });
    const typescript = await transformToolsForCodeMode(alphaTools, {
      serverName: "alpha",
      language: "typescript",
      outputDir: tsDir,
    });
    try {
      materializeFiles(pythonDir, python.files);
      materializeFiles(tsDir, typescript.files);
      expect(
        normalizePaths(python.tools.alpha_help?.description ?? "", { [pythonDir]: "<python-dir>" }),
      ).toBe(golden("agent-facing/code/alpha-python-help-tool-description.txt"));
      expect(
        normalizePaths(typescript.tools.alpha_help?.description ?? "", { [tsDir]: "<ts-dir>" }),
      ).toBe(golden("agent-facing/code/alpha-typescript-help-tool-description.txt"));

      expect(readFileSync(join(pythonDir, "alpha.py"), "utf8")).toContain('"""Echo a message."""');
      expect(readFileSync(join(tsDir, "alpha.d.ts"), "utf8")).toContain("Echo a message.");
    } finally {
      python.close();
      typescript.close();
    }
  });

  it("snapshots Atlassian-like Python code signatures", async () => {
    const pythonDir = mkdtempSync(join(tmpdir(), "mcp-atlassian-python-snapshot-"));
    const transform = await transformToolsForCodeMode(
      {
        atlassianUserInfo: {
          name: "atlassianUserInfo",
          description: "Get current user info",
          inputSchema: { type: "object", properties: {} },
          execute: async (): Promise<unknown> => "ok",
        },
        searchJiraIssuesUsingJql: {
          name: "searchJiraIssuesUsingJql",
          description: "Search issues with JQL",
          inputSchema: {
            type: "object",
            properties: {
              cloudId: { type: "string", description: "Cloud ID" },
              jql: { type: "string", description: "JQL query" },
              maxResults: { type: "number", description: "Max results" },
              fields: { type: "array", items: { type: "string" }, description: "Fields" },
            },
            required: ["cloudId", "jql"],
          },
          execute: async (): Promise<unknown> => "ok",
        },
      },
      { serverName: "atlassian", language: "python", outputDir: pythonDir },
    );
    try {
      materializeFiles(pythonDir, transform.files);
      expect(
        normalizePaths(transform.tools.atlassian_help?.description ?? "", {
          [pythonDir]: "<python-dir>",
        }),
      ).toBe(golden("agent-facing/code/atlassian-python-help-tool-description.txt"));
      const source = readFileSync(join(pythonDir, "atlassian.py"), "utf8");
      expect(source).toContain("def atlassian_user_info() -> str:");
      expect(source).toContain(
        "def search_jira_issues_using_jql(cloud_id, jql, max_results=None, fields=None) -> str:",
      );
      expect(source).toContain(JSON.stringify("cloudId") + ": cloud_id");
      expect(source).not.toContain("def atlassianUserInfo(");
    } finally {
      transform.close();
    }
  });

  it("snapshots standard compressed tool descriptions and responses", async () => {
    const compressed = compressTools(alphaTools, {
      compressionLevel: "medium",
      namePrefix: "alpha",
    });
    expect(
      toStableJson(
        Object.fromEntries(
          Object.entries(compressed).map(([name, tool]) => [name, tool.description]),
        ),
      ),
    ).toBe(golden("agent-facing/compressed/alpha-tool-descriptions.json"));

    await expect(compressed.alpha_get_tool_schema?.execute({ tool_name: "echo" })).resolves.toBe(
      golden("agent-facing/compressed/alpha-get-schema-echo.txt"),
    );

    await expect(
      compressed.alpha_invoke_tool?.execute({
        tool_name: "echo",
        tool_input: { message: "snapshot" },
      }),
    ).resolves.toBe(golden("agent-facing/compressed/alpha-invoke-echo.txt"));
  });
});

// The host-owned bridge runs in this process, so invocations that reach it must
// not block the event loop the way execFileSync does.
async function runScriptAsync(scriptPath: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      scriptPath,
      [...args],
      { encoding: "utf8", shell: process.platform === "win32" },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`${error.message}\n${stderr}`));
          return;
        }
        resolve(stdout.trimEnd().replace(/\r\n/g, "\n"));
      },
    );
  });
}

describe("CLI and Just Bash output parity", () => {
  // Outputs that a content-sniffing converter could mistake for structured data.
  // Both surfaces must return them verbatim unless toonify is explicitly enabled.
  const fidelityTools: Record<string, ExecutableTool<unknown>> = {
    plain_text_with_commas: {
      name: "plain_text_with_commas",
      description: "Return prose that looks a bit like CSV.",
      inputSchema: { type: "object", properties: {} },
      execute: async () => "Hello,world\nFoo,bar",
    },
    yaml_like_text: {
      name: "yaml_like_text",
      description: "Return prose with colons.",
      inputSchema: { type: "object", properties: {} },
      execute: async () => "Note: this is prose\nStatus: not YAML",
    },
    json_text: {
      name: "json_text",
      description: "Return a JSON-looking string.",
      inputSchema: { type: "object", properties: {} },
      execute: async () => '{"results": [1, 2, 3], "result": "inner"}',
    },
    structured: {
      name: "structured",
      description: "Return a structured object.",
      inputSchema: { type: "object", properties: {} },
      execute: async () => ({ rows: [{ id: 1, ok: true }], total: 1 }),
    },
  };

  it("returns tool output verbatim and identically by default", async () => {
    const outputDir = mkdtempSync(join(tmpdir(), "mcp-fidelity-cli-"));
    const cli = await transformToolsForCliMode(fidelityTools, { serverName: "fid", outputDir });
    const bash = new Bash({ customCommands: [] });
    transformToolsForJustBash(fidelityTools, { serverName: "fid", bash });
    try {
      materializeFiles(outputDir, cli.files, ["fid"]);
      const scriptPath = generatedScriptPath(outputDir, "fid");
      const expected: Record<string, string> = {
        "plain-text-with-commas": "Hello,world\nFoo,bar",
        "yaml-like-text": "Note: this is prose\nStatus: not YAML",
        "json-text": '{"results": [1, 2, 3], "result": "inner"}',
        structured: '{"rows":[{"id":1,"ok":true}],"total":1}',
      };
      for (const [subcommand, output] of Object.entries(expected)) {
        const viaBash = await bash.exec(`fid ${subcommand}`);
        expect(viaBash.exitCode, subcommand).toBe(0);
        expect(viaBash.stdout.trimEnd(), subcommand).toBe(output);
        expect(await runScriptAsync(scriptPath, [subcommand]), subcommand).toBe(output);
      }
      const piped = await bash.exec("fid structured | jq -r '.rows[0].id'");
      expect(piped.stdout.trim()).toBe("1");
    } finally {
      cli.close();
    }
  });

  it("reports usage and tool errors identically", async () => {
    const schema = (properties: Record<string, unknown>, required: string[] = []) => ({
      type: "object",
      properties,
      required,
    });
    const errorTools: Record<string, ExecutableTool<unknown>> = {
      search_issues: {
        name: "search_issues",
        description: "Search issues.",
        inputSchema: schema(
          {
            query: { type: "string" },
            order: { type: "string", enum: ["asc", "desc"] },
            limit: { type: "integer" },
          },
          ["query"],
        ),
        execute: async (input) => input,
      },
      nested: {
        name: "nested",
        description: "Echo nested input.",
        inputSchema: schema({ filters: { type: "object" } }, ["filters"]),
        execute: async (input) => input,
      },
      fail: {
        name: "fail",
        description: "Always fails.",
        inputSchema: schema({}),
        execute: async () => {
          throw new Error("backend exploded: code 42");
        },
      },
    };
    const usage = (message: string, help: string) => `${message}\nRun '${help} --help' for usage.`;
    // Usage errors exit 2 with a pointer to help; tool errors exit 1 with the
    // tool's own message. Neither writes to stdout.
    const cases: Array<{ args: string[]; exitCode: number; stderr: string }> = [
      {
        args: ["search-issues", "--query", "x", "--order", "sideways"],
        exitCode: 2,
        stderr: usage(
          "parse error: invalid value for --order: sideways (expected one of: asc, desc)",
          "errs search-issues",
        ),
      },
      {
        args: ["search-issues", "--query", "x", "--limit", "ten"],
        exitCode: 2,
        stderr: usage("parse error: invalid integer value for --limit: ten", "errs search-issues"),
      },
      {
        args: ["search-issues"],
        exitCode: 2,
        stderr: usage("validation error: missing required argument: --query", "errs search-issues"),
      },
      {
        args: ["search-issues", "--query", "x", "--unknown", "1"],
        exitCode: 2,
        stderr: usage("parse error: unknown flag: --unknown", "errs search-issues"),
      },
      {
        args: ["search-issues", "--query"],
        exitCode: 2,
        stderr: usage("parse error: --query requires a value", "errs search-issues"),
      },
      {
        args: ["bogus"],
        exitCode: 2,
        stderr: usage("parse error: unknown subcommand: bogus", "errs"),
      },
      {
        args: ["nested", "--filters", "{bad"],
        exitCode: 2,
        stderr: usage("parse error: invalid JSON object for --filters: {bad", "errs nested"),
      },
      { args: ["fail"], exitCode: 1, stderr: "backend exploded: code 42" },
    ];

    const outputDir = mkdtempSync(join(tmpdir(), "mcp-errors-cli-"));
    const cli = await transformToolsForCliMode(errorTools, { serverName: "errs", outputDir });
    const bash = new Bash({ customCommands: [] });
    transformToolsForJustBash(errorTools, { serverName: "errs", bash });
    try {
      materializeFiles(outputDir, cli.files, ["errs"]);
      const scriptPath = generatedScriptPath(outputDir, "errs");
      for (const { args, exitCode, stderr } of cases) {
        const label = args.join(" ");
        const viaBash = await bash.exec(`errs ${args.map((arg) => `'${arg}'`).join(" ")}`);
        expect(
          { exitCode: viaBash.exitCode, stdout: viaBash.stdout, stderr: viaBash.stderr.trimEnd() },
          label,
        ).toEqual({ exitCode, stdout: "", stderr });
        const viaCli = await runScriptResult(scriptPath, args);
        expect(viaCli, label).toEqual({ exitCode, stdout: "", stderr });
      }
    } finally {
      cli.close();
    }
  });
});

async function runScriptResult(
  scriptPath: string,
  args: readonly string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      scriptPath,
      [...args],
      { encoding: "utf8", shell: process.platform === "win32" },
      (error, stdout, stderr) => {
        const exitCode = error ? Number((error as { code?: unknown }).code ?? 1) : 0;
        const normalize = (text: string) => text.trimEnd().replace(/\r\n/g, "\n");
        resolve({ exitCode, stdout: normalize(stdout), stderr: normalize(stderr) });
      },
    );
  });
}
