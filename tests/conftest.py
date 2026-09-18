from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest


@pytest.fixture(scope="session")
def rust_core_binary() -> Path:
    result = subprocess.run(
        ["cargo", "build", "-p", "mcp-compressor-core", "--bin", "mcp-compressor", "--message-format=json"],  # noqa: S607
        cwd=Path(__file__).resolve().parents[1],
        stdout=subprocess.PIPE,
        encoding="utf-8",
        check=True,
    )
    for line in result.stdout.splitlines():
        artifact = json.loads(line)
        if (
            artifact.get("reason") == "compiler-artifact"
            and artifact["target"]["name"] == "mcp-compressor"
            and artifact.get("executable")
        ):
            binary = Path(artifact["executable"])
            assert binary.is_file(), f"Cargo reported a missing CLI executable: {binary}"
            return binary
    raise AssertionError("Cargo did not report the built mcp-compressor executable")
