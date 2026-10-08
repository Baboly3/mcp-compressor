//! Shared Rust core for mcp-compressor.
//!
//! # Module layout
//!
//! | Module | Responsibility |
//! |---|---|
//! | [`compression`] | Pure tool-listing formatter and schema lookup |
//! | [`config`] | MCP config JSON parsing, server naming |
//! | [`proxy`] | Generic HTTP tool proxy with bearer-token auth |
//! | [`client_gen`] | Artifact generators (shell, Python, TypeScript) |
//! | [`cli`] | CLI name mapping and argv → tool-input parsing |
//! | [`server`] | `CompressedServer`, `ToolCache`, tool registration |
//! | [`ffi`] | FFI-safe surface for PyO3 / napi-rs language bindings |

pub mod app;
pub mod cli;
pub mod client_gen;
pub mod compression;
pub mod config;
pub mod error;
pub mod ffi;
pub mod llm_assist;
pub mod oauth;
pub mod proxy;
pub mod sdk;
pub mod server;

pub use error::Error;

static PRODUCT_VERSION: std::sync::OnceLock<String> = std::sync::OnceLock::new();

/// Record the version of the distribution embedding this core.
///
/// The Python and npm packages compile the core from an unversioned
/// manifest, so they pass their own package version; the crates.io binary
/// is stamped at release and needs no call. The first call wins.
pub fn set_product_version(version: impl Into<String>) {
    let _ = PRODUCT_VERSION.set(version.into());
}

/// The version reported to MCP clients as `serverInfo.version`.
pub fn product_version() -> &'static str {
    PRODUCT_VERSION
        .get()
        .map(String::as_str)
        .unwrap_or(env!("CARGO_PKG_VERSION"))
}
