mod common;

use std::{ffi::OsString, sync::Mutex};

use mcp_compressor_core::app::entrypoint::run_from;

const EXIT_AFTER_READY_ENV: &str = "MCP_COMPRESSOR_EXIT_AFTER_READY";
static ENV_LOCK: Mutex<()> = Mutex::new(());

struct EnvVarGuard {
    name: &'static str,
    previous: Option<OsString>,
}

impl EnvVarGuard {
    fn capture(name: &'static str) -> Self {
        Self {
            name,
            previous: std::env::var_os(name),
        }
    }

    fn set(name: &'static str, value: &str) -> Self {
        let guard = Self::capture(name);
        std::env::set_var(name, value);
        guard
    }
}

impl Drop for EnvVarGuard {
    fn drop(&mut self) {
        if let Some(previous) = &self.previous {
            std::env::set_var(self.name, previous);
        } else {
            std::env::remove_var(self.name);
        }
    }
}

/// A caller stack far below what argument parsing plus the CLI's top-level
/// future needs. Measured on Windows debug builds: without the entrypoint's own
/// sized thread, the run overflows even at 512 KiB, while with it 128 KiB is
/// still enough, so this sits clear of both bounds.
const SMALL_CALLER_STACK_SIZE: usize = 256 * 1024;

/// `run_from` must run on a stack it sizes itself, not on the caller's.
///
/// The process main thread reserves 1 MiB on Windows and is not ours to resize,
/// and embedders may call the entrypoint from any thread. Both `clap` parsing
/// and the aggregated startup/discovery/transform future are large and grow as
/// command paths are added, and exhausting the stack aborts the whole process
/// with only "has overflowed its stack" and no backtrace.
///
/// Driving the entrypoint from a deliberately small thread pins that guarantee:
/// without the re-spawn the test binary dies with STATUS_STACK_OVERFLOW rather
/// than failing an assertion.
#[test]
fn cli_entrypoint_runs_on_its_own_stack_not_the_callers() {
    let _lock = ENV_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let tempdir = tempfile::tempdir().unwrap();
    let config_path = tempdir.path().join("mcp.json");
    // Serialized rather than interpolated: the fixture path is absolute, and on
    // Windows its separators would otherwise land in the JSON as escapes.
    let config = serde_json::json!({
        "mcpServers": {
            "alpha": {
                "command": common::python_command(),
                "args": [common::fixture_path("alpha_server.py")],
            }
        }
    });
    std::fs::write(&config_path, config.to_string()).unwrap();

    let _exit_after_ready = EnvVarGuard::set(EXIT_AFTER_READY_ENV, "1");

    let worker = std::thread::Builder::new()
        .stack_size(SMALL_CALLER_STACK_SIZE)
        .spawn(move || {
            run_from([
                "mcp-compressor".to_string(),
                "--just-bash".to_string(),
                "--config".to_string(),
                config_path.to_string_lossy().into_owned(),
            ])
        })
        .expect("spawn small-stack caller");

    let result = worker.join().expect("the entrypoint thread panicked");
    result.expect("the entrypoint must complete from a small caller stack");
}

#[test]
fn env_var_guard_restores_previous_value_after_unwind() {
    let _lock = ENV_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let _original = EnvVarGuard::set(EXIT_AFTER_READY_ENV, "original");

    let panic = std::panic::catch_unwind(|| {
        let _changed = EnvVarGuard::set(EXIT_AFTER_READY_ENV, "changed");
        panic!("simulate test failure");
    });

    assert!(panic.is_err());
    assert_eq!(
        std::env::var_os(EXIT_AFTER_READY_ENV),
        Some("original".into())
    );
}

#[test]
fn env_var_guard_removes_value_that_was_initially_absent() {
    let _lock = ENV_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let _original = EnvVarGuard::capture(EXIT_AFTER_READY_ENV);
    std::env::remove_var(EXIT_AFTER_READY_ENV);

    {
        let _changed = EnvVarGuard::set(EXIT_AFTER_READY_ENV, "changed");
    }

    assert_eq!(std::env::var_os(EXIT_AFTER_READY_ENV), None);
}
