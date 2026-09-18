from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FIXTURE = ROOT / "crates" / "mcp-compressor-core" / "tests" / "fixtures" / "alpha_server.py"
PYTHON = os.environ.get("PYTHON", sys.executable)


def test_public_cli_mode_creates_executable_script(tmp_path: Path, rust_core_binary: Path) -> None:
    output_dir = tmp_path / "bin"

    result = subprocess.run(  # noqa: S603
        [
            str(rust_core_binary),
            "--cli-mode",
            "--server-name",
            "alpha",
            "--output-dir",
            str(output_dir),
            "--",
            PYTHON,
            str(FIXTURE),
        ],
        cwd=tmp_path,
        env={**os.environ, "MCP_COMPRESSOR_EXIT_AFTER_READY": "1"},
        encoding="utf-8",
        capture_output=True,
        check=True,
        timeout=30,
    )

    assert "CLI ready" in result.stdout
    assert (output_dir / "alpha").exists()


def test_public_code_modes_default_to_dist(tmp_path: Path, rust_core_binary: Path) -> None:
    for language, expected in [("python", "alpha.py"), ("typescript", "alpha.ts")]:
        result = subprocess.run(  # noqa: S603
            [
                str(rust_core_binary),
                "--code-mode",
                language,
                "--server-name",
                "alpha",
                "--",
                PYTHON,
                str(FIXTURE),
            ],
            cwd=tmp_path,
            env={**os.environ, "MCP_COMPRESSOR_EXIT_AFTER_READY": "1"},
            encoding="utf-8",
            capture_output=True,
            check=True,
            timeout=30,
        )
        assert "code client ready" in result.stdout
        assert "Import the generated client" in result.stdout
        assert "Invoke with:" not in result.stdout
        assert (tmp_path / "dist" / expected).exists()


async def test_public_multiserver_mcp_config_exposes_expected_wrapper_tools(
    tmp_path: Path, rust_core_binary: Path
) -> None:
    from fastmcp import Client

    config = tmp_path / "mcp.json"
    config.write_text(
        json.dumps({
            "mcpServers": {
                "alpha": {"command": PYTHON, "args": [str(FIXTURE)]},
                "beta": {
                    "command": PYTHON,
                    "args": [str(ROOT / "crates" / "mcp-compressor-core" / "tests" / "fixtures" / "beta_server.py")],
                },
            }
        })
    )

    async with Client({
        "mcpServers": {
            "rust": {
                "command": str(rust_core_binary),
                "args": ["--compression", "max", "--config", str(config)],
            }
        }
    }) as client:
        tool_names = {tool.name for tool in await client.list_tools()}

    assert {
        "alpha_get_tool_schema",
        "alpha_invoke_tool",
        "alpha_list_tools",
        "beta_get_tool_schema",
        "beta_invoke_tool",
        "beta_list_tools",
    }.issubset(tool_names)


def test_public_backend_options_belong_after_separator(tmp_path: Path, rust_core_binary: Path) -> None:
    before = subprocess.run(  # noqa: S603
        [str(rust_core_binary), "--cwd", str(tmp_path), "--", PYTHON, str(FIXTURE)],
        encoding="utf-8",
        capture_output=True,
        timeout=30,
    )
    assert before.returncode != 0
    assert "unexpected argument '--cwd'" in before.stderr

    after = subprocess.run(  # noqa: S603
        [
            str(rust_core_binary),
            "--cli-mode",
            "--server-name",
            "alpha",
            "--output-dir",
            str(tmp_path / "bin"),
            "--",
            PYTHON,
            str(FIXTURE),
            "--cwd",
            str(tmp_path),
            "-e",
            "PUBLIC_WORKFLOW_SMOKE=1",
        ],
        env={**os.environ, "MCP_COMPRESSOR_EXIT_AFTER_READY": "1"},
        encoding="utf-8",
        capture_output=True,
        check=True,
        timeout=30,
    )
    assert "CLI ready" in after.stdout
