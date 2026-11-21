//! The only place that spawns git (contracts/DECISIONS.md D4). Read-only sub-commands, a fixed
//! hardening prefix, a scrubbed environment and validated revisions: nothing a checked-out tree
//! controls (attributes, hooks, fsmonitor, external diff / textconv drivers, odd file names) can
//! execute code or hide a change.

use crate::sanitize::term;
use std::path::{Path, PathBuf};
use std::process::Command;

/// Settings forced on every git call (D4.2).
pub const HARDEN: &[&str] = &[
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "core.untrackedCache=false",
    "-c",
    "core.pager=cat",
    "-c",
    "diff.external=",
    "-c",
    "core.quotePath=false",
    "-c",
    "diff.noprefix=false",
    "-c",
    "diff.mnemonicPrefix=false",
    "-c",
    "diff.relative=false",
    "-c",
    "diff.renames=false",
    "-c",
    "submodule.recurse=false",
    "-c",
    "core.sshCommand=false",
    "-c",
    "credential.helper=",
    "--no-pager",
];

/// Environment variables removed from every git call (D4.3).
pub const ENV_REMOVE: &[&str] = &[
    "GIT_EXTERNAL_DIFF",
    "GIT_DIFF_OPTS",
    "GIT_PAGER",
    "PAGER",
    "GIT_ASKPASS",
    "GIT_SSH",
    "GIT_SSH_COMMAND",
    "GIT_CONFIG_COUNT",
    "GIT_CONFIG_PARAMETERS",
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
];

/// Read-only sub-commands (D4.4).
pub const ALLOWED: &[&str] = &["rev-parse", "diff", "ls-files", "cat-file", "status", "merge-base"];

/// Flags of every `git diff` (D4.5). Renames are never detected: a rename is delete + add.
pub const DIFF_FLAGS: &[&str] = &[
    "--no-ext-diff",
    "--no-textconv",
    "--no-color",
    "--text",
    "--no-renames",
    "-U0",
    "--src-prefix=a/",
    "--dst-prefix=b/",
    "--ignore-submodules=none",
];

/// stdout bound (D4.6)
pub const MAX_OUTPUT: usize = 256 << 20;

/// Absolute path of the git executable from PATH. Relative PATH entries, empty entries and the
/// current directory are never used (SECURITY-REVIEW F16, D4.1).
pub fn find_git() -> Option<PathBuf> {
    let exe = if cfg!(windows) { "git.exe" } else { "git" };
    let cwd = std::env::current_dir().ok();
    for dir in std::env::split_paths(&std::env::var_os("PATH")?) {
        if dir.as_os_str().is_empty() || !dir.is_absolute() || cwd.as_deref() == Some(dir.as_path()) {
            continue;
        }
        let p = dir.join(exe);
        if p.is_file() {
            return Some(p);
        }
    }
    None
}

/// A revision accepted from the user: no option-like or odd strings (F1, D4.5).
pub fn valid_rev(s: &str) -> bool {
    !s.is_empty() && s.len() <= 256 && !s.starts_with('-') && s.bytes().all(|c| c.is_ascii_alphanumeric() || b"._/~^@{}-".contains(&c))
}

pub fn is_sha(s: &str) -> bool {
    (s.len() == 40 || s.len() == 64) && s.bytes().all(|c| c.is_ascii_hexdigit())
}

pub struct Git {
    bin: Option<PathBuf>,
    root: String,
}

impl Git {
    /// `root` = canonical project root (D2.1).
    pub fn new(root: &str) -> Self {
        Git { bin: find_git(), root: root.to_string() }
    }

    /// Runs one read-only git command; any failure is an `Err` (callers turn it into "run all").
    pub fn run(&self, args: &[&str]) -> Result<Vec<u8>, String> {
        let Some(bin) = &self.bin else { return Err("git executable not found on PATH".into()) };
        let sub = args.first().copied().unwrap_or("");
        if !ALLOWED.contains(&sub) {
            return Err(format!("git {sub}: sub-command not allowed"));
        }
        let mut c = Command::new(bin);
        c.arg("-C").arg(&self.root).args(HARDEN).args(args);
        for k in ENV_REMOVE {
            c.env_remove(k);
        }
        for (k, _) in std::env::vars_os() {
            if k.to_string_lossy().starts_with("GIT_CONFIG_KEY_") || k.to_string_lossy().starts_with("GIT_CONFIG_VALUE_") {
                c.env_remove(k);
            }
        }
        c.env("GIT_OPTIONAL_LOCKS", "0").env("GIT_TERMINAL_PROMPT", "0").env("LC_ALL", "C");
        c.stdin(std::process::Stdio::null());
        let out = c.output().map_err(|e| format!("git: {e}"))?;
        if !out.status.success() {
            return Err(format!("git {sub}: {}", term(String::from_utf8_lossy(&out.stderr).trim())));
        }
        if out.stdout.len() > MAX_OUTPUT {
            return Err(format!("git {sub}: output above {MAX_OUTPUT} bytes"));
        }
        Ok(out.stdout)
    }

    /// Resolves a (validated) revision to a full commit SHA.
    pub fn resolve_commit(&self, rev: &str) -> Result<String, String> {
        if !valid_rev(rev) {
            return Err(format!("invalid revision {:?} (must be a revision, not an option)", term(rev)));
        }
        let spec = format!("{rev}^{{commit}}");
        let out = self.run(&["rev-parse", "--verify", "--quiet", "--end-of-options", &spec]).map_err(|e| {
            if e.ends_with(": ") || e.ends_with(':') { format!("unknown revision {:?}", term(rev)) } else { e }
        })?;
        let sha = String::from_utf8_lossy(&out).trim().to_string();
        if !is_sha(&sha) {
            return Err(format!("cannot resolve {:?}", term(rev)));
        }
        Ok(sha)
    }

    /// Unified diff `sha` → working tree (tracked files), hardened flags, no rename detection.
    pub fn diff_worktree(&self, sha: &str) -> Result<String, String> {
        if !is_sha(sha) {
            return Err("diff base must be a resolved commit SHA".into());
        }
        let mut a: Vec<&str> = vec!["diff"];
        a.extend_from_slice(DIFF_FLAGS);
        a.extend_from_slice(&["--end-of-options", sha, "--"]);
        Ok(String::from_utf8_lossy(&self.run(&a)?).into_owned())
    }

    /// Untracked, not ignored files (repository-relative, NUL-split – names are never unquoted).
    pub fn untracked(&self) -> Result<Vec<String>, String> {
        let out = self.run(&["ls-files", "-z", "--others", "--exclude-standard", "--full-name"])?;
        Ok(out.split(|&b| b == 0).filter(|f| !f.is_empty()).map(|f| String::from_utf8_lossy(f).into_owned()).collect())
    }

    /// Canonical git top level.
    pub fn toplevel(&self) -> Result<String, String> {
        let out = self.run(&["rev-parse", "--show-toplevel"])?;
        let s = String::from_utf8_lossy(&out).trim().to_string();
        Ok(crate::paths::canonical_root(Path::new(&s)))
    }

    /// Content of `path` (relative to the git top level) at commit `sha`.
    pub fn blob(&self, sha: &str, path: &str) -> Result<Vec<u8>, String> {
        if !is_sha(sha) {
            return Err("blob: commit must be a resolved SHA".into());
        }
        self.run(&["cat-file", "blob", "--end-of-options", &format!("{sha}:{path}")])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn revisions() {
        for ok in ["HEAD", "HEAD~2", "origin/main", "v1.0^{commit}", "a1b2c3d", "feature/x-1", "main@{1}"] {
            assert!(valid_rev(ok), "{ok}");
        }
        for bad in ["", "-p", "--output=x", "HEAD --output=x", "a;b", "a\nb", "$(x)", "a:b", "a..b\t"] {
            assert!(!valid_rev(bad), "{bad:?}");
        }
        assert!(is_sha(&"a".repeat(40)) && is_sha(&"0".repeat(64)) && !is_sha("abc") && !is_sha(&"g".repeat(40)));
    }

    #[test]
    fn only_read_only_subcommands() {
        let g = Git::new("/");
        for sub in ["fetch", "checkout", "stash", "gc", "config", "-c", "--exec-path=/x", ""] {
            let e = g.run(&[sub]).unwrap_err();
            assert!(e.contains("not allowed") || e.contains("not found"), "{sub}: {e}");
        }
    }

    /// D4: every hardening key documented in contracts/DECISIONS.md is in the prefix, and the
    /// document lists nothing the code does not do.
    #[test]
    fn matches_decisions_document() {
        let doc = include_str!("../../contracts/DECISIONS.md");
        for kv in HARDEN.iter().filter(|s| s.contains('=')) {
            assert!(doc.contains(kv), "DECISIONS.md D4 does not list `-c {kv}`");
        }
        for f in DIFF_FLAGS {
            assert!(doc.contains(f), "DECISIONS.md D4 does not list diff flag {f}");
        }
        for e in ENV_REMOVE {
            assert!(doc.contains(e), "DECISIONS.md D4 does not list env {e}");
        }
        for s in ALLOWED {
            assert!(doc.contains(&format!("`{s}`")), "DECISIONS.md D4 does not list sub-command {s}");
        }
    }
}
