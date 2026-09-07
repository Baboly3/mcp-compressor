use std::path::PathBuf;

/// Select where generated CLI scripts should be written.
///
/// Returns `(directory, on_path)` where `on_path` indicates whether the
/// directory is already on the user's `PATH`.
pub fn cli_output_dir() -> std::io::Result<(PathBuf, bool)> {
    if let Some(path) = std::env::var_os("MCP_COMPRESSOR_CLI_OUTPUT_DIR") {
        return Ok((PathBuf::from(path), true));
    }

    let path_dirs = path_dirs();
    if let Some(output_dir) = select_script_dir(cfg!(windows), candidate_script_dirs(), &path_dirs)
    {
        return Ok(output_dir);
    }

    Ok((std::env::current_dir()?, false))
}

fn select_script_dir(
    windows: bool,
    candidates: Vec<PathBuf>,
    path_dirs: &[PathBuf],
) -> Option<(PathBuf, bool)> {
    if windows {
        let candidate = candidates.into_iter().next()?;
        let resolved = candidate.canonicalize().unwrap_or(candidate);
        let on_path = path_dirs.iter().any(|path_dir| {
            path_dir
                .as_os_str()
                .eq_ignore_ascii_case(resolved.as_os_str())
        });
        return Some((resolved, on_path));
    }

    for candidate in candidates {
        let resolved = candidate.canonicalize().unwrap_or(candidate.clone());
        if resolved.is_dir() && path_dirs.iter().any(|path_dir| path_dir == &resolved) {
            return Some((resolved, true));
        }
    }

    None
}

fn candidate_script_dirs() -> Vec<PathBuf> {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let user_profile = std::env::var_os("USERPROFILE").map(PathBuf::from);
    candidate_script_dirs_for(cfg!(windows), home, user_profile)
}

/// Rank the directories a generated CLI may be installed into.
///
/// User-owned directories come first on every platform. On Windows
/// `%LOCALAPPDATA%\Microsoft\WindowsApps` is on `PATH` by default, but it is
/// reserved for App Execution Aliases and is rewritten by the Store, so it is
/// never an installation candidate.
fn candidate_script_dirs_for(
    windows: bool,
    home: Option<PathBuf>,
    user_profile: Option<PathBuf>,
) -> Vec<PathBuf> {
    let home = if windows { home.or(user_profile) } else { home };
    let mut candidates = Vec::new();
    if windows {
        if let Some(home) = &home {
            candidates.push(home.join(".local").join("bin"));
        }
    } else {
        if let Some(home) = &home {
            candidates.push(home.join(".local").join("bin"));
            candidates.push(home.join("bin"));
        }
        candidates.push(PathBuf::from("/usr/local/bin"));
        candidates.push(PathBuf::from("/opt/homebrew/bin"));
    }
    candidates
}

fn path_dirs() -> Vec<PathBuf> {
    std::env::var_os("PATH")
        .map(|path| {
            std::env::split_paths(&path)
                .map(|entry| entry.canonicalize().unwrap_or(entry))
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_only_offers_the_user_owned_directory() {
        let candidates = candidate_script_dirs_for(
            true,
            Some(PathBuf::from(r"C:\Users\dev")),
            Some(PathBuf::from(r"C:\Users\fallback")),
        );

        assert_eq!(
            candidates,
            vec![PathBuf::from(r"C:\Users\dev").join(".local").join("bin")]
        );
    }

    #[test]
    fn windows_uses_userprofile_when_home_is_missing() {
        let candidates =
            candidate_script_dirs_for(true, None, Some(PathBuf::from(r"C:\Users\dev")));

        assert_eq!(
            candidates,
            vec![PathBuf::from(r"C:\Users\dev").join(".local").join("bin")]
        );
    }

    #[test]
    fn windows_has_no_implicit_install_directory_without_a_home_directory() {
        let candidates = candidate_script_dirs_for(true, None, None);

        assert!(candidates.is_empty());
    }

    #[test]
    fn unix_does_not_use_userprofile_when_home_is_missing() {
        let candidates =
            candidate_script_dirs_for(false, None, Some(PathBuf::from("/windows/profile")));

        assert_eq!(
            candidates,
            vec![
                PathBuf::from("/usr/local/bin"),
                PathBuf::from("/opt/homebrew/bin"),
            ]
        );
    }

    #[test]
    fn windows_selects_the_user_owned_directory_even_when_only_windows_apps_is_on_path() {
        let tempdir = tempfile::tempdir().unwrap();
        let user_bin = tempdir.path().join(".local").join("bin");
        let windows_apps = tempdir.path().join("Microsoft").join("WindowsApps");
        std::fs::create_dir_all(&windows_apps).unwrap();
        let windows_apps = windows_apps.canonicalize().unwrap();

        let selected = select_script_dir(
            true,
            vec![user_bin.clone(), windows_apps.clone()],
            &[windows_apps],
        );

        assert_eq!(selected, Some((user_bin, false)));
    }

    #[test]
    fn windows_reports_nonexistent_user_owned_directory_as_on_path_when_listed() {
        let tempdir = tempfile::tempdir().unwrap();
        let user_bin = tempdir.path().join(".local").join("bin");
        assert!(!user_bin.exists());

        let selected = select_script_dir(true, vec![user_bin.clone()], &[user_bin.clone()]);

        assert_eq!(selected, Some((user_bin, true)));
    }

    #[test]
    fn windows_matches_nonexistent_path_entries_case_insensitively() {
        let user_bin = PathBuf::from(r"C:\Users\dev\.local\bin");
        let listed_path = PathBuf::from(r"c:\users\DEV\.LOCAL\BIN");

        let selected = select_script_dir(true, vec![user_bin.clone()], &[listed_path]);

        assert_eq!(selected, Some((user_bin, true)));
    }

    #[test]
    fn unix_ranks_user_directories_before_shared_prefixes() {
        let candidates = candidate_script_dirs_for(false, Some(PathBuf::from("/home/dev")), None);

        assert_eq!(
            candidates,
            vec![
                PathBuf::from("/home/dev/.local/bin"),
                PathBuf::from("/home/dev/bin"),
                PathBuf::from("/usr/local/bin"),
                PathBuf::from("/opt/homebrew/bin"),
            ]
        );
    }
}
