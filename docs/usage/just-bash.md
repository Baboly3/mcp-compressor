# Just Bash

Just Bash mode lets command-oriented agents call MCP tools as shell-style commands.

Use it when your agent already has a Just Bash environment and you want MCP tools to appear as commands. Each server becomes one command with a subcommand per tool, exactly like a generated CLI:

```text
alpha echo --message hello
beta search --query "release notes"
alpha --help
alpha echo --help
```

## TypeScript host helper

```ts
import { Bash } from "just-bash";
import { CompressorClient, installJustBashCommands } from "@atlassian/mcp-compressor";

const proxy = await new CompressorClient({ servers, mode: "bash" }).connect();
try {
  const bash = new Bash({ customCommands: [] });
  installJustBashCommands(bash, proxy);

  const result = await bash.exec("alpha echo --message hello");
  console.log(result.stdout);
} finally {
  proxy.close();
}
```

## Python host helper

```python
from mcp_compressor import CompressorClient, install_just_bash_commands

class BashHost:
    def __init__(self) -> None:
        self.custom_commands = {}

with CompressorClient(servers=servers, mode="bash") as proxy:
    bash = BashHost()
    install_just_bash_commands(bash, proxy)
    result = bash.custom_commands["alpha"](["echo", "--message", "hello"])
    print(result.exit_code, result.stdout, result.stderr)
```

Python Just Bash hosts aren't standardized, so the helper registers callables on `custom_commands` or `commands` (a mapping or a list). Each callable takes the argument list and returns a `JustBashExecResult` with `stdout`, `stderr` and `exit_code`, the same shape as a TypeScript Just Bash `ExecResult`.

## Local tool functions

If your application already has executable tool functions in memory, you can install them directly into a Bash host without connecting to an MCP server.

=== "TypeScript"

    ```ts
    import { transformToolsForJustBash } from "@atlassian/mcp-compressor";

    const result = transformToolsForJustBash(tools, {
      bash,
      serverName: "alpha",
    });

    await bash.exec("alpha echo --message hello");
    ```

=== "Python"

    ```python
    from mcp_compressor import transform_tools_for_just_bash

    result = transform_tools_for_just_bash(
        tools,
        bash=bash,
        server_name="alpha",
    )

    bash.custom_commands["alpha"](["echo", "--message", "hello"])
    ```

## Command names

Both languages register one command per server, named after the server, with one subcommand per tool. Several servers can expose tools with the same name without clashing:

```text
alpha echo --message hello
beta echo --message hello
```

## Errors

Commands follow the same argument and error rules as generated CLIs: usage errors exit `2` with a pointer to `--help`, and tool failures exit `1` with the tool's message on stderr. See [Arguments and errors](generated-clients.md#arguments-and-errors).

## Lifecycle

Generated commands call the active `mcp-compressor` session or the local tool functions you provided. Keep that session or host application alive for as long as the agent needs to run the commands.
