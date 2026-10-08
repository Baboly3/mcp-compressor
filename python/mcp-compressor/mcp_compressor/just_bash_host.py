from __future__ import annotations

from collections.abc import Callable, MutableMapping
from dataclasses import dataclass, field
from typing import Any

from mcp_compressor.client import CompressorProxy
from mcp_compressor.core import ToolSpec, parse_tool_argv, render_cli_subcommand_help, render_cli_top_level_help

HELP_FLAGS = ("--help", "-h")


@dataclass(frozen=True)
class JustBashExecResult:
    """Outcome of one command, shaped like a Just Bash `ExecResult`.

    Usage errors exit 2 with a pointer to `--help`; tool failures exit 1 with
    the tool's message. Both write only to stderr.
    """

    stdout: str
    stderr: str
    exit_code: int


@dataclass(frozen=True)
class JustBashSubcommand:
    """One tool exposed as `<server> <subcommand>`."""

    name: str
    backend_tool_name: str
    tool: ToolSpec


@dataclass(frozen=True)
class JustBashServerCommand:
    """One server exposed as a single command with a subcommand per tool.

    Mirrors the TypeScript Just Bash commands and generated CLIs:
    `alpha echo --message hi`, `alpha --help`, `alpha echo --help`.
    """

    provider_name: str
    command_name: str
    help_tool_name: str
    subcommands: list[JustBashSubcommand]
    invoke: Callable[[str, dict[str, Any]], str] = field(repr=False)

    def __call__(self, args: list[str] | None = None) -> JustBashExecResult:
        args = list(args or [])
        try:
            if not args or args[0] in (*HELP_FLAGS, "help"):
                return _output(render_cli_top_level_help(self.command_name, [s.tool for s in self.subcommands]))
            name, tool_args = args[0], args[1:]
            subcommand = self._lookup(name)
            if subcommand is None:
                return _usage_failure(f"parse error: unknown subcommand: {name}", self.command_name)
            if any(arg in HELP_FLAGS for arg in tool_args):
                return _output(render_cli_subcommand_help(self.command_name, subcommand.tool))
            try:
                tool_input = parse_tool_argv(subcommand.tool, tool_args)
            except ValueError as error:
                return _usage_failure(str(error), f"{self.command_name} {name}")
            return _output(self.invoke(subcommand.backend_tool_name, tool_input))
        except Exception as error:
            return JustBashExecResult(stdout="", stderr=f"{error}\n", exit_code=1)

    def _lookup(self, name: str) -> JustBashSubcommand | None:
        for subcommand in self.subcommands:
            aliases = (
                subcommand.name,
                subcommand.backend_tool_name.replace("_", "-"),
                subcommand.backend_tool_name,
            )
            if name in aliases:
                return subcommand
        return None


def _output(stdout: str) -> JustBashExecResult:
    return JustBashExecResult(stdout=f"{stdout}\n", stderr="", exit_code=0)


def _usage_failure(message: str, help_command: str) -> JustBashExecResult:
    return JustBashExecResult(
        stdout="",
        stderr=f"{message}\nRun '{help_command} --help' for usage.\n",
        exit_code=2,
    )


def install_commands(bash: Any, commands: list[JustBashServerCommand]) -> None:
    """Register commands on a host exposing `custom_commands`/`commands` (mapping or list)."""
    for attribute in ("custom_commands", "commands"):
        target = getattr(bash, attribute, None)
        if isinstance(target, MutableMapping):
            target.update({command.command_name: command for command in commands})
            return
        if isinstance(target, list):
            target.extend(commands)
            return
    bash.custom_commands = {command.command_name: command for command in commands}


def install_just_bash_commands(bash: Any, proxy: CompressorProxy) -> list[JustBashServerCommand]:
    """Install one command per proxied server into a Python Just Bash host.

    The Python Just Bash ecosystem is less standardized than the TypeScript
    package, so this helper supports the common mutable shapes used by hosts:
    `custom_commands` or `commands` as either a mapping or a list. It returns the
    generated command objects in all cases so callers can adapt custom hosts.
    """
    commands = create_just_bash_commands(proxy)
    install_commands(bash, commands)
    return commands


def create_just_bash_commands(proxy: CompressorProxy) -> list[JustBashServerCommand]:
    """Create one Just Bash command per proxied server, with a subcommand per tool.

    This mirrors the TypeScript `installJustBashCommands` helper: Rust owns the
    compressed proxy and provider metadata, while the language host decides how
    to register and execute commands.
    """
    commands: list[JustBashServerCommand] = []
    for provider in proxy.just_bash_providers:

        def invoke(tool_name: str, tool_input: dict[str, Any], *, server: str = provider.provider_name) -> str:
            return proxy.invoke(tool_name, tool_input, server=server)

        commands.append(
            JustBashServerCommand(
                provider_name=provider.provider_name,
                command_name=provider.provider_name,
                help_tool_name=provider.help_tool_name,
                subcommands=[
                    JustBashSubcommand(
                        name=command.command_name,
                        backend_tool_name=command.backend_tool_name,
                        tool=ToolSpec(
                            name=command.backend_tool_name,
                            description=command.description,
                            input_schema=command.input_schema,
                        ),
                    )
                    for command in provider.tools
                ],
                invoke=invoke,
            )
        )
    return commands
