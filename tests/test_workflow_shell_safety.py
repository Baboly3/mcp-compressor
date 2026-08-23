"""Guards against PowerShell workflow steps that chain native commands.

GitHub's ``shell: pwsh`` wrapper propagates the last native command's exit
code, so each native build or test command must run in its own workflow step.
"""

from __future__ import annotations

from pathlib import Path

import pytest
import yaml

WORKFLOWS = Path(__file__).resolve().parents[1] / ".github" / "workflows"


def _pwsh_steps() -> list[tuple[str, str, str]]:
    steps: list[tuple[str, str, str]] = []
    for workflow in sorted(WORKFLOWS.glob("*.yml")):
        document = yaml.safe_load(workflow.read_text(encoding="utf-8")) or {}
        for job_name, job in (document.get("jobs") or {}).items():
            job_shell = ((job.get("defaults") or {}).get("run") or {}).get("shell")
            for step in job.get("steps") or []:
                run = step.get("run")
                if not run:
                    continue
                if (step.get("shell") or job_shell) != "pwsh":
                    continue
                label = f"{workflow.name}::{job_name}::{step.get('name', run.splitlines()[0])}"
                steps.append((label, run, job_name))
    return steps


def test_pwsh_steps_do_not_chain_multiple_commands() -> None:
    offenders = []
    for label, run, _job in _pwsh_steps():
        commands = [line for line in run.splitlines() if line.strip()]
        if len(commands) > 1 or any(operator in run for operator in (";", "&&", "||", "|", "`")):
            offenders.append(label)

    assert not offenders, (
        f"chained pwsh commands can hide an earlier native-command failure; split them into separate steps: {offenders}"
    )


@pytest.mark.parametrize(
    ("directory", "command"),
    [
        (None, "cargo test -p mcp-compressor-core --tests -- --nocapture"),
        (None, "cargo test -p mcp-compressor --tests -- --nocapture"),
        (None, "uv run pytest -q tests"),
        ("python/mcp-compressor", "uv run pytest -q tests"),
        ("typescript", "bun run check"),
    ],
)
def test_windows_runs_complete_test_suites(directory: str | None, command: str) -> None:
    document = yaml.safe_load((WORKFLOWS / "main.yml").read_text(encoding="utf-8"))
    job = document["jobs"]["windows-contracts"]
    assert job["runs-on"] == "windows-latest"
    assert job.get("if") is None
    assert not job.get("continue-on-error")
    assert job["env"]["PYTHON"] == r"${{ github.workspace }}\.venv\Scripts\python.exe"
    step = next(
        (
            step
            for step in job["steps"]
            if step.get("run", "").strip() == command and step.get("working-directory") == directory
        ),
        None,
    )
    assert step is not None, f"Windows must execute {command!r} in {directory or 'the repository root'}"
    assert step.get("if") is None
    assert not step.get("continue-on-error")
    assert (step.get("shell") or job["defaults"]["run"]["shell"]) == "pwsh"


def test_workflow_contracts_run_before_windows_builds() -> None:
    document = yaml.safe_load((WORKFLOWS / "main.yml").read_text(encoding="utf-8"))
    steps = document["jobs"]["windows-contracts"]["steps"]
    commands = [step.get("run", "").strip() for step in steps]
    assert commands.index("uv run pytest -q tests/test_workflow_shell_safety.py") < commands.index(
        "cargo test -p mcp-compressor-core --tests -- --nocapture"
    )


def test_windows_installs_typescript_dependencies_before_repository_tests() -> None:
    document = yaml.safe_load((WORKFLOWS / "main.yml").read_text(encoding="utf-8"))
    steps = document["jobs"]["windows-contracts"]["steps"]
    install = next(
        index
        for index, step in enumerate(steps)
        if step.get("run") == "bun install --frozen-lockfile" and step.get("working-directory") == "typescript"
    )
    root_tests = next(
        index
        for index, step in enumerate(steps)
        if step.get("run") == "uv run pytest -q tests" and step.get("working-directory") is None
    )
    assert install < root_tests
