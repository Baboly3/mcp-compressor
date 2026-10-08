# Just Bash

Just Bash mode lets command-oriented agents call MCP tools as shell-style commands.

Use it when your agent already has a Just Bash environment and you want MCP tools to appear as commands. In TypeScript each server becomes one command with a subcommand per tool, exactly like a generated CLI:

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
    print(bash.custom_commands["echo"](["--message", "hello"]))
```

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
    ```

## Command names

TypeScript registers one command per server, named after the server, with one subcommand per tool. Several servers can expose tools with the same name without clashing:

```text
alpha echo --message hello
beta echo --message hello
```

The Python helpers register one callable per tool instead:

- `install_just_bash_commands` uses the tool's command name (`echo`), prefixed with the server name only when two servers share it (`alpha_echo`, `beta_echo`).
- `transform_tools_for_just_bash` always prefixes it: `alpha_echo`.

Python callables return the tool output as a string and raise on errors. They don't print to stderr or set exit codes.

## Errors

TypeScript commands follow the same argument and error rules as generated CLIs: usage errors exit `2` with a pointer to `--help`, and tool failures exit `1` with the tool's message on stderr. See [Arguments and errors](generated-clients.md#arguments-and-errors).

## Lifecycle

Generated commands call the active `mcp-compressor` session or the local tool functions you provided. Keep that session or host application alive for as long as the agent needs to run the commands.
