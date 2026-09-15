"""Guards against PowerShell workflow steps that chain native commands.

GitHub's ``shell: pwsh`` wrapper propagates the last native command's exit
code, so each native build or test command must run in its own workflow step.
"""

from __future__ import annotations

import os
import shutil
import subprocess
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
        commands = [line for line in run.splitlines() if line.strip() and not line.lstrip().startswith("#")]
        if len(commands) > 1 or any(
            operator in command for command in commands for operator in (";", "&&", "||", "|", "`")
        ):
            offenders.append(label)

    assert not offenders, (
        f"chained pwsh commands can hide an earlier native-command failure; split them into separate steps: {offenders}"
    )


@pytest.mark.parametrize(
    ("run", "chained"),
    [
        ("cargo test", False),
        ("\n  # Explain the command\ncargo test\n", False),
        ("# Avoid ; && || | ` chaining\ncargo test", False),
        ("cargo test\n  # Trailing comment", False),
        ("# Comment only; no commands", False),
        ("cargo test\n# Separate commands\ncargo check", True),
        *[(f"# Comment\ncargo test {operator} cargo check", True) for operator in (";", "&&", "||", "|", "`")],
    ],
)
def test_pwsh_guard_distinguishes_comments_from_commands(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, run: str, chained: bool
) -> None:
    workflow = {"jobs": {"example": {"defaults": {"run": {"shell": "pwsh"}}, "steps": [{"run": run}]}}}
    (tmp_path / "example.yml").write_text(yaml.safe_dump(workflow), encoding="utf-8")
    monkeypatch.setitem(globals(), "WORKFLOWS", tmp_path)

    if chained:
        with pytest.raises(AssertionError, match="chained pwsh commands"):
            test_pwsh_steps_do_not_chain_multiple_commands()
    else:
        test_pwsh_steps_do_not_chain_multiple_commands()


@pytest.mark.parametrize(
    ("suite", "directory", "command"),
    [
        ("rust", None, "cargo test -p mcp-compressor-core --tests -- --nocapture"),
        ("rust", None, "cargo test -p mcp-compressor --tests -- --nocapture"),
        ("rust", None, "uv run pytest -q tests"),
        ("python", "python/mcp-compressor", "uv run --no-sync pytest -q tests"),
        ("typescript", "typescript", "bun run check"),
    ],
)
def test_windows_runs_complete_test_suites(suite: str, directory: str | None, command: str) -> None:
    document = yaml.safe_load((WORKFLOWS / "main.yml").read_text(encoding="utf-8"))
    job = document["jobs"]["windows-tests"]
    assert job["runs-on"] == "windows-latest"
    assert job["strategy"]["fail-fast"] is False
    assert job["strategy"]["matrix"] == {"suite": ["rust", "python", "typescript"]}
    assert job["strategy"].get("max-parallel", 3) >= 3
    assert not job.get("needs"), "Windows suites must run independently, not wait for another build"
    assert job.get("if") is None
    assert not job.get("continue-on-error")
    assert not any(step.get("continue-on-error") for step in job["steps"])
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
    assert step.get("if") == f"matrix.suite == '{suite}'"
    assert not step.get("continue-on-error")
    assert (step.get("shell") or job["defaults"]["run"]["shell"]) == "pwsh"


def test_workflow_contracts_run_before_windows_builds() -> None:
    document = yaml.safe_load((WORKFLOWS / "main.yml").read_text(encoding="utf-8"))
    steps = document["jobs"]["windows-tests"]["steps"]
    commands = [step.get("run", "").strip() for step in steps]
    contracts = commands.index("uv run pytest -q tests/test_workflow_shell_safety.py")
    for build in (
        "cargo test -p mcp-compressor-core --tests -- --nocapture",
        "uv sync --frozen --group dev --config-settings build-args=--profile=dev",
        "bun run build:core",
        "bun run build:native",
    ):
        assert contracts < commands.index(build)
    assert steps[contracts].get("if") is None


def test_windows_installs_typescript_dependencies_before_repository_tests() -> None:
    document = yaml.safe_load((WORKFLOWS / "main.yml").read_text(encoding="utf-8"))
    steps = document["jobs"]["windows-tests"]["steps"]
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
    assert steps[install].get("if") == "matrix.suite != 'python'"
    bun = next(index for index, step in enumerate(steps) if step.get("uses") == "oven-sh/setup-bun@v2")
    assert steps[bun].get("if") == "matrix.suite != 'python'"
    assert bun < install


def test_windows_uses_one_python_native_build() -> None:
    document = yaml.safe_load((WORKFLOWS / "main.yml").read_text(encoding="utf-8"))
    steps = document["jobs"]["windows-tests"]["steps"]
    commands = [step.get("run", "") for step in steps]
    sync = commands.index("uv sync --frozen --group dev --config-settings build-args=--profile=dev")
    assert steps[sync]["working-directory"] == "python/mcp-compressor"
    assert steps[sync]["if"] == "matrix.suite != 'typescript'"
    assert sync < commands.index("uv run --no-sync pytest -q tests")
    assert not any("maturin develop" in command for command in commands)


def test_windows_root_tests_keep_the_python_native_import_prerequisite() -> None:
    document = yaml.safe_load((WORKFLOWS / "main.yml").read_text(encoding="utf-8"))
    steps = document["jobs"]["windows-tests"]["steps"]
    commands = [step.get("run", "") for step in steps]
    build = "uv sync --frozen --group dev --config-settings build-args=--profile=dev"
    assert build in commands, "Root Atlassian tests import the Python extension before checking credentials"
    index = commands.index(build)
    assert steps[index]["if"] == "matrix.suite != 'typescript'"
    assert steps[index]["working-directory"] == "python/mcp-compressor"
    assert commands.index("cargo test -p mcp-compressor --tests -- --nocapture") < index
    assert index < commands.index("uv run pytest -q tests")


@pytest.mark.parametrize("command", ["bun run lint", "bun run format:check", "bun run typecheck"])
def test_windows_typescript_checks_precede_native_builds(command: str) -> None:
    document = yaml.safe_load((WORKFLOWS / "main.yml").read_text(encoding="utf-8"))
    steps = document["jobs"]["windows-tests"]["steps"]
    commands = [step.get("run", "") for step in steps]
    check = commands.index(command)
    assert steps[check]["working-directory"] == "typescript"
    assert steps[check]["if"] == "matrix.suite == 'typescript'"
    assert commands.index("bun install --frozen-lockfile") < check < commands.index("bun run build:core")
    assert check < commands.index("bun run build:native")


def test_windows_caches_cargo_artifacts_for_each_lane_without_branch_restrictions() -> None:
    document = yaml.safe_load((WORKFLOWS / "main.yml").read_text(encoding="utf-8"))
    steps = document["jobs"]["windows-tests"]["steps"]
    cache = next(step for step in steps if step.get("uses") == "actions/cache@v5")
    assert cache.get("if") is None
    assert set(cache["with"]["path"].splitlines()) == {"~/.cargo/registry", "~/.cargo/git", "target"}
    key = cache["with"]["key"]
    for scope in (
        "runner.os",
        "runner.arch",
        "matrix.suite",
        "steps.rust.outputs.cachekey",
        "Cargo.lock",
        "Cargo.toml",
        "setup-python-env/action.yml",
        "python/mcp-compressor/uv.lock",
        "typescript/bun.lock",
    ):
        assert scope in key
    assert "github.sha" in key
    assert cache["with"]["restore-keys"].strip() == key.removesuffix("${{ github.sha }}")
    rust = next(step for step in steps if step.get("uses") == "dtolnay/rust-toolchain@stable")
    assert rust["id"] == "rust"
    setup = next(step for step in steps if step.get("uses") == "./.github/actions/setup-python-env")
    assert steps.index(setup) < steps.index(cache)
    assert steps.index(rust) < steps.index(cache)
    first_build = next(index for index, step in enumerate(steps) if step.get("run", "").startswith("cargo test"))
    assert steps.index(cache) < first_build


@pytest.mark.parametrize("result", ["success", "failure", "cancelled", "skipped", ""])
def test_windows_summary_requires_success_from_all_matrix_lanes(result: str) -> None:
    document = yaml.safe_load((WORKFLOWS / "main.yml").read_text(encoding="utf-8"))
    job = document["jobs"]["windows-contracts"]
    assert job["needs"] == ["windows-tests"]
    assert job["if"] == "${{ always() }}"
    assert not job.get("continue-on-error")
    assert len(job["steps"]) == 1
    step = job["steps"][0]
    assert step.get("if") is None
    assert not step.get("continue-on-error")
    assert step["env"] == {"WINDOWS_RESULT": "${{ needs.windows-tests.result }}"}
    assert step["shell"] == "pwsh"
    pwsh = shutil.which("pwsh")
    if pwsh is None:
        pytest.skip("PowerShell is required to execute the aggregate status contract")
    assert pwsh is not None
    completed = subprocess.run(  # noqa: S603
        [pwsh, "-NoProfile", "-NonInteractive", "-Command", step["run"]],
        env={**os.environ, "WINDOWS_RESULT": result},
        capture_output=True,
        timeout=30,
    )
    assert (completed.returncode == 0) == (result == "success"), completed.stderr
