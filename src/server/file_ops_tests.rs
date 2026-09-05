use super::*;
use std::{fs, path::{Path, PathBuf}};

struct Fixture(PathBuf);

impl Fixture {
    fn new() -> Self {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let root = std::env::temp_dir().join(format!("coffee-file-ops-{}-{unique}", std::process::id()));
        fs::create_dir(&root).unwrap();
        Self(root)
    }

    fn path(&self, name: &str) -> String {
        self.0.join(name).to_string_lossy().into_owned()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); }
}

fn dir_link(target: &Path, link: &Path) {
    #[cfg(unix)]
    std::os::unix::fs::symlink(target, link).unwrap();
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // Junctions need no Developer Mode or elevation, including on CI.
        let result = std::process::Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command",
                "New-Item -ItemType Junction -Path $env:COFFEE_TEST_LINK -Target $env:COFFEE_TEST_TARGET -ErrorAction Stop | Out-Null"])
            .env("COFFEE_TEST_LINK", link).env("COFFEE_TEST_TARGET", target)
            .creation_flags(0x0800_0000).output().unwrap();
        assert!(result.status.success(), "{}", String::from_utf8_lossy(&result.stderr));
    }
}

#[test]
fn deleting_directory_link_preserves_target() {
    let f = Fixture::new();
    fs::create_dir(f.path("target")).unwrap();
    fs::write(f.path("target/keep.txt"), "keep").unwrap();
    dir_link(&f.0.join("target"), &f.0.join("link"));
    fs_delete(f.path("link")).unwrap();
    assert_eq!(fs::read_to_string(f.path("target/keep.txt")).unwrap(), "keep");
    assert!(fs::symlink_metadata(f.path("link")).is_err());
}

#[test]
fn deleting_dangling_link_succeeds() {
    let f = Fixture::new();
    fs::create_dir(f.path("target")).unwrap();
    dir_link(&f.0.join("target"), &f.0.join("link"));
    fs::remove_dir(f.path("target")).unwrap();
    fs_delete(f.path("link")).unwrap();
    assert!(fs::symlink_metadata(f.path("link")).is_err());
}

#[test]
fn paste_and_rename_reject_existing_targets() {
    let f = Fixture::new();
    fs::create_dir(f.path("dest")).unwrap();
    fs::write(f.path("item.txt"), "source").unwrap();
    fs::write(f.path("dest/item.txt"), "destination").unwrap();
    for action in ["copy", "cut"] {
        assert!(fs_paste(action.into(), f.path("item.txt"), f.path("dest")).is_err());
        assert_eq!(fs::read_to_string(f.path("dest/item.txt")).unwrap(), "destination");
        assert_eq!(fs::read_to_string(f.path("item.txt")).unwrap(), "source");
    }
    fs::write(f.path("other.txt"), "other").unwrap();
    assert!(fs_rename(f.path("item.txt"), "other.txt".into()).is_err());
    assert_eq!(fs::read_to_string(f.path("other.txt")).unwrap(), "other");
}

#[test]
fn paste_rejects_self_and_descendant_before_writing() {
    let f = Fixture::new();
    fs::create_dir_all(f.path("source/child")).unwrap();
    fs::write(f.path("source/keep.txt"), "keep").unwrap();
    assert!(fs_paste("copy".into(), f.path("source"), f.path("")).is_err());
    assert!(fs_paste("copy".into(), f.path("source"), f.path("source/child")).is_err());
    assert!(!Path::new(&f.path("source/child/source")).exists());
}

#[test]
fn rename_requires_one_name_and_moves_link_itself() {
    let f = Fixture::new();
    fs::create_dir(f.path("parent")).unwrap();
    fs::write(f.path("parent/item.txt"), "keep").unwrap();
    for name in ["../escaped.txt", "..", "", "nested/name.txt", "nested\\name.txt"] {
        assert!(fs_rename(f.path("parent/item.txt"), name.into()).is_err(), "accepted {name}");
    }
    assert!(!Path::new(&f.path("escaped.txt")).exists());
    dir_link(&f.0.join("parent"), &f.0.join("link"));
    fs_rename(f.path("link"), "renamed-link".into()).unwrap();
    assert!(Path::new(&f.path("parent/item.txt")).exists());
    assert!(fs::symlink_metadata(f.path("renamed-link")).is_ok());
}

#[test]
fn ordinary_copy_move_rename_delete_preserve_contents() {
    let f = Fixture::new();
    fs::create_dir_all(f.path("source/subdir")).unwrap();
    fs::create_dir(f.path("dest")).unwrap();
    fs::write(f.path("source/subdir/item.txt"), "hello").unwrap();
    fs_paste("copy".into(), f.path("source"), f.path("dest")).unwrap();
    assert_eq!(fs::read_to_string(f.path("dest/source/subdir/item.txt")).unwrap(), "hello");
    fs_rename(f.path("dest/source"), "renamed".into()).unwrap();
    fs_paste("cut".into(), f.path("dest/renamed"), f.path("")).unwrap();
    assert!(!Path::new(&f.path("dest/renamed")).exists());
    fs_delete(f.path("renamed")).unwrap();
    assert!(Path::new(&f.path("source/subdir/item.txt")).exists());
}

#[cfg(unix)]
#[test]
fn copy_preserves_symlinks_without_following_cycles() {
    let f = Fixture::new();
    fs::create_dir(f.path("source")).unwrap();
    fs::create_dir(f.path("dest")).unwrap();
    std::os::unix::fs::symlink(".", f.path("source/loop")).unwrap();
    std::os::unix::fs::symlink("missing", f.path("source/dangling")).unwrap();
    fs_paste("copy".into(), f.path("source"), f.path("dest")).unwrap();
    assert_eq!(fs::read_link(f.path("dest/source/loop")).unwrap(), Path::new("."));
    assert_eq!(fs::read_link(f.path("dest/source/dangling")).unwrap(), Path::new("missing"));
}

#[test]
fn invalid_open_targets_never_launch_a_handler() {
    for target in ["", "-aCalculator", "https://example.invalid/\0ignored"] {
        assert!(open_url(target.into()).is_err());
    }
}

#[test]
fn paste_resolves_target_alias_before_rejecting_descendant() {
    let f = Fixture::new();
    fs::create_dir_all(f.path("source/child")).unwrap();
    dir_link(&f.0.join("source/child"), &f.0.join("alias"));
    assert!(fs_paste("copy".into(), f.path("source"), f.path("alias")).is_err());
    assert!(!Path::new(&f.path("source/child/source")).exists());
}

#[test]
fn root_and_top_level_directories_are_rejected() {
    #[cfg(windows)]
    let paths = ["C:\\", "C:\\Windows", "\\\\server\\share\\top"];
    #[cfg(unix)]
    let paths = ["/", "/etc", "/usr"];
    for path in paths { assert!(validate_fs_depth(Path::new(path)).is_err()); }
}
