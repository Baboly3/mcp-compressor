import { defineCommand } from "just-bash";
import type { Command, ExecResult } from "just-bash";

import {
  parseToolArgv,
  renderCliSubcommandHelp,
  renderCliTopLevelHelp,
  type ToolSpec,
} from "./rust_core.js";
import { normalizeStructuredArgValues } from "./tool_specs.js";

export interface JustBashCommandRegistration {
  providerName: string;
  commandName: string;
  backendToolName: string;
  helpToolName: string;
  command: Command;
}

export interface JustBashCommandSource {
  providerName: string;
  commandName: string;
  backendToolName: string;
  helpToolName: string;
  tool: ToolSpec;
  invoke(input: Record<string, unknown>): Promise<string>;
}

export function createJustBashCommandRegistrations(
  sources: JustBashCommandSource[],
): JustBashCommandRegistration[] {
  const grouped = new Map<string, JustBashCommandSource[]>();
  for (const source of sources) {
    grouped.set(source.providerName, [...(grouped.get(source.providerName) ?? []), source]);
  }

  return [...grouped.entries()].map(([providerName, providerSources]) => {
    const bySubcommand = new Map(
      providerSources.flatMap((source) => [
        [source.commandName, source] as const,
        [source.backendToolName.replaceAll("_", "-"), source] as const,
        [source.backendToolName, source] as const,
      ]),
    );
    const first = providerSources[0];
    return {
      providerName,
      commandName: providerName,
      backendToolName: providerName,
      helpToolName: first?.helpToolName ?? `${providerName}_help`,
      command: defineCommand(providerName, async (args) => {
        try {
          const [subcommand, ...toolArgs] = args;
          if (
            subcommand === undefined ||
            subcommand === "--help" ||
            subcommand === "-h" ||
            subcommand === "help"
          ) {
            return output(
              renderCliTopLevelHelp(
                providerName,
                providerName,
                providerSources.map((source) => source.tool),
              ),
            );
          }
          const source = bySubcommand.get(subcommand);
          if (source === undefined) {
            return usageFailure(`parse error: unknown subcommand: ${subcommand}`, providerName);
          }
          // Per-subcommand help must match the generated CLI's rich `--help`
          // output, so render it from the shared Rust renderer.
          if (toolArgs.includes("--help") || toolArgs.includes("-h")) {
            return output(renderCliSubcommandHelp(providerName, source.tool));
          }
          let toolInput: Record<string, unknown>;
          try {
            const parsedInput = parseToolArgv(source.tool, toolArgs);
            toolInput = normalizeStructuredArgValues(source.tool.inputSchema, parsedInput);
          } catch (error) {
            return usageFailure(errorMessage(error), `${providerName} ${subcommand}`);
          }
          return output(await source.invoke(toolInput));
        } catch (error) {
          return failure(error);
        }
      }),
    };
  });
}

export function installJustBashRegistrations(
  bash: unknown,
  registrations: JustBashCommandRegistration[],
): void {
  const host = bash as {
    customCommands?: Command[];
    registerCommand?: (command: Command) => void;
  };
  if (typeof host.registerCommand === "function") {
    for (const registration of registrations) host.registerCommand(registration.command);
  } else {
    host.customCommands = [
      ...(host.customCommands ?? []),
      ...registrations.map((registration) => registration.command),
    ];
  }
}

function output(stdout: string): ExecResult {
  return { stdout: `${stdout}\n`, stderr: "", exitCode: 0 };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A failed tool call: the tool's own message, exit 1. */
function failure(error: unknown): ExecResult {
  return { stdout: "", stderr: `${errorMessage(error)}\n`, exitCode: 1 };
}

/**
 * A malformed invocation, reported exactly like the generated CLI script:
 * the parser's message, a pointer to `--help`, and exit 2.
 */
function usageFailure(message: string, helpCommand: string): ExecResult {
  return {
    stdout: "",
    stderr: `${message}\nRun '${helpCommand} --help' for usage.\n`,
    exitCode: 2,
  };
}
