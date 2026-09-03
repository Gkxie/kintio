use std::collections::BTreeMap;
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use tempfile::TempDir;

use super::{CliContext, INSTANCE_CONFIG_TEMPLATE, MANAGED_SKILL_CONTENT, run_cli};

const CONFIG_ENVIRONMENT_NAMES: &[&str] = &[
    "CODEX_ENABLED",
    "CODEX_IMAGE_TMP_DIR",
    "CODEX_WORKING_DIRECTORY",
    "HARNESS_DB_FILE",
    "ILINK_API_TIMEOUT_MS",
    "ILINK_BASE_URL",
    "ILINK_ENABLED",
    "ILINK_LONG_POLL_TIMEOUT_MS",
    "ILINK_MAX_ACCOUNTS",
    "ILINK_STORAGE_KEY",
    "ILINK_STORAGE_KEY_FILE",
    "KINTIO_CONFIG_FILE",
    "KINTIO_DB_FILE",
    "KINTIO_HOME",
    "PORT",
    "SHUTDOWN_TIMEOUT_MS",
    "TALKFERRY_DB_FILE",
    "WECOM_ALLOWED_USER_IDS",
    "WECOM_API_BASE_URL",
    "WECOM_API_TIMEOUT_MS",
    "WECOM_AUTH_CONFIRMATION",
    "WECOM_AUTH_TRIGGER",
    "WECOM_AUTH_TRIGGER_COUNT",
    "WECOM_CALLBACK_TOKEN",
    "WECOM_CORP_ID",
    "WECOM_DB_FILE",
    "WECOM_ENCODING_AES_KEY",
    "WECOM_KF_SECRET",
    "WECOM_MCP_OBSERVE_MS",
    "WECOM_RECEIVE_ID",
];

fn context(project: &Path) -> CliContext {
    CliContext::new(
        project.to_path_buf(),
        dirs::home_dir().expect("test host has a home directory"),
        BTreeMap::new(),
    )
}

fn run_rust_setup(
    project: &Path,
    home: &Path,
    config: Option<&Path>,
) -> (String, anyhow::Result<()>) {
    let mut arguments = vec![
        OsString::from("kintio-rs"),
        OsString::from("setup"),
        OsString::from("--home"),
        home.as_os_str().to_os_string(),
    ];
    if let Some(config) = config {
        arguments.extend([
            OsString::from("--config"),
            config.as_os_str().to_os_string(),
        ]);
    }
    let mut output = Vec::new();
    let result = run_cli(arguments, &context(project), &mut output);
    (
        String::from_utf8(output).expect("setup output is UTF-8"),
        result,
    )
}

fn run_typescript_setup(project: &Path, home: &Path, config: Option<&Path>) -> String {
    let mut command = Command::new("node");
    for name in CONFIG_ENVIRONMENT_NAMES {
        command.env_remove(name);
    }
    command
        .current_dir(project)
        .arg("--experimental-strip-types")
        .arg("cli.ts")
        .arg("setup")
        .arg("--home")
        .arg(home);
    if let Some(config) = config {
        command.arg("--config").arg(config);
    }
    let output = command.output().expect("TypeScript setup starts");
    assert!(
        output.status.success(),
        "TypeScript setup failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).expect("TypeScript setup output is UTF-8")
}

fn normalize_output(source: &str, home: &Path) -> String {
    source.replace(&home.to_string_lossy().to_string(), "<HOME>")
}

fn assert_setup_tree(home: &Path, config: &Path) {
    let skill = home.join("codex-workspace/.agents/skills/wechat-kf-reply-sop/SKILL.md");
    assert_eq!(
        fs::read_to_string(config).unwrap(),
        INSTANCE_CONFIG_TEMPLATE
    );
    assert_eq!(fs::read_to_string(&skill).unwrap(), MANAGED_SKILL_CONTENT);

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        for directory in [
            home.to_path_buf(),
            home.join("data"),
            home.join("codex-workspace"),
            home.join("codex-workspace/.agents/skills/wechat-kf-reply-sop"),
        ] {
            assert_eq!(
                fs::metadata(directory).unwrap().permissions().mode() & 0o777,
                0o700
            );
        }
        for file in [config.to_path_buf(), skill] {
            assert_eq!(
                fs::metadata(file).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }
}

#[test]
fn rust_setup_matches_typescript_files_output_and_preservation() {
    let project = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let root = TempDir::new().unwrap();
    let typescript_home = root.path().join("typescript-instance");
    let rust_home = root.path().join("rust-instance");

    let typescript_output = run_typescript_setup(&project, &typescript_home, None);
    let (rust_output, result) = run_rust_setup(&project, &rust_home, None);
    result.unwrap();
    assert_eq!(
        normalize_output(&rust_output, &rust_home),
        normalize_output(&typescript_output, &typescript_home),
    );
    assert_setup_tree(&typescript_home, &typescript_home.join(".env"));
    assert_setup_tree(&rust_home, &rust_home.join(".env"));

    let custom = format!("{INSTANCE_CONFIG_TEMPLATE}\n# operator-owned value\n");
    fs::write(typescript_home.join(".env"), &custom).unwrap();
    fs::write(rust_home.join(".env"), &custom).unwrap();
    fs::write(
        typescript_home.join("codex-workspace/.agents/skills/wechat-kf-reply-sop/SKILL.md"),
        "stale\n",
    )
    .unwrap();
    fs::write(
        rust_home.join("codex-workspace/.agents/skills/wechat-kf-reply-sop/SKILL.md"),
        "stale\n",
    )
    .unwrap();
    #[cfg(unix)]
    for home in [&typescript_home, &rust_home] {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(
            home.join("codex-workspace/.agents/skills/wechat-kf-reply-sop/SKILL.md"),
            fs::Permissions::from_mode(0o644),
        )
        .unwrap();
    }

    let typescript_output = run_typescript_setup(&project, &typescript_home, None);
    let (rust_output, result) = run_rust_setup(&project, &rust_home, None);
    result.unwrap();
    assert_eq!(
        normalize_output(&rust_output, &rust_home),
        normalize_output(&typescript_output, &typescript_home),
    );
    assert_eq!(
        fs::read_to_string(typescript_home.join(".env")).unwrap(),
        custom
    );
    assert_eq!(fs::read_to_string(rust_home.join(".env")).unwrap(), custom);
    assert_eq!(
        fs::read_to_string(
            rust_home.join("codex-workspace/.agents/skills/wechat-kf-reply-sop/SKILL.md")
        )
        .unwrap(),
        MANAGED_SKILL_CONTENT,
    );
}

#[test]
fn setup_honors_custom_config_and_keeps_it() {
    let project = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let root = TempDir::new().unwrap();
    let home = root.path().join("instance");
    let config = root.path().join("configuration").join("custom.env");
    let (output, result) = run_rust_setup(&project, &home, Some(&config));
    result.unwrap();
    assert!(output.contains(&format!("Config: {} (created)", config.display())));
    assert_setup_tree(&home, &config);

    fs::write(&config, "CODEX_WORKING_DIRECTORY=./agent-home\n").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&config, fs::Permissions::from_mode(0o600)).unwrap();
    }
    let (output, result) = run_rust_setup(&project, &home, Some(&config));
    result.unwrap();
    assert!(output.contains(&format!("Config: {} (kept)", config.display())));
    assert_eq!(
        fs::read_to_string(&config).unwrap(),
        "CODEX_WORKING_DIRECTORY=./agent-home\n"
    );
    assert_eq!(
        fs::read_to_string(home.join("agent-home/.agents/skills/wechat-kf-reply-sop/SKILL.md"))
            .unwrap(),
        MANAGED_SKILL_CONTENT,
    );
}

#[test]
fn setup_uses_the_context_home_without_explicit_location_options() {
    let project = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let profile = TempDir::new().unwrap();
    let context = CliContext::new(project, profile.path().to_path_buf(), BTreeMap::new());
    let mut output = Vec::new();

    run_cli(
        [OsString::from("kintio-rs"), OsString::from("setup")],
        &context,
        &mut output,
    )
    .unwrap();

    let home = profile.path().join(".kintio");
    assert_setup_tree(&home, &home.join(".env"));
}

#[cfg(windows)]
#[test]
fn setup_accepts_windows_paths_that_only_differ_in_case() {
    let project = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let root = TempDir::new().unwrap();
    let home = root.path().join("Mixed-Case-Instance");
    let lowercase_config = PathBuf::from(home.to_string_lossy().to_lowercase()).join(".env");

    let (_, result) = run_rust_setup(&project, &home, Some(&lowercase_config));
    result.unwrap();

    assert_setup_tree(&home, &home.join(".env"));
}

#[cfg(unix)]
#[test]
fn setup_rejects_symlinks_non_files_and_unsafe_permissions() {
    use std::os::unix::fs::{PermissionsExt, symlink};

    let project = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let root = TempDir::new().unwrap();

    let legacy_home = root.path().join("legacy-home");
    fs::create_dir(&legacy_home).unwrap();
    fs::set_permissions(&legacy_home, fs::Permissions::from_mode(0o755)).unwrap();
    let (_, result) = run_rust_setup(&project, &legacy_home, None);
    result.unwrap();
    assert_eq!(
        fs::metadata(&legacy_home).unwrap().permissions().mode() & 0o777,
        0o755,
    );
    assert_eq!(
        fs::read_to_string(legacy_home.join(".env")).unwrap(),
        INSTANCE_CONFIG_TEMPLATE,
    );

    let shared_ancestor_home = root.path().join("shared-ancestor-home");
    let shared_skill_parent = shared_ancestor_home
        .join("codex-workspace")
        .join(".agents")
        .join("skills");
    fs::create_dir_all(&shared_skill_parent).unwrap();
    fs::set_permissions(&shared_ancestor_home, fs::Permissions::from_mode(0o700)).unwrap();
    for directory in [
        shared_ancestor_home.join("codex-workspace"),
        shared_ancestor_home.join("codex-workspace").join(".agents"),
        shared_skill_parent,
    ] {
        fs::set_permissions(directory, fs::Permissions::from_mode(0o755)).unwrap();
    }
    let (_, result) = run_rust_setup(&project, &shared_ancestor_home, None);
    result.unwrap();

    let symlink_home = root.path().join("symlink-home");
    fs::create_dir(&symlink_home).unwrap();
    fs::set_permissions(&symlink_home, fs::Permissions::from_mode(0o700)).unwrap();
    let target = root.path().join("target.env");
    fs::write(&target, INSTANCE_CONFIG_TEMPLATE).unwrap();
    fs::set_permissions(&target, fs::Permissions::from_mode(0o600)).unwrap();
    symlink(&target, symlink_home.join(".env")).unwrap();
    let (_, result) = run_rust_setup(&project, &symlink_home, None);
    assert!(
        result
            .unwrap_err()
            .to_string()
            .contains("not a regular file")
    );

    let directory_home = root.path().join("directory-home");
    fs::create_dir(&directory_home).unwrap();
    fs::set_permissions(&directory_home, fs::Permissions::from_mode(0o700)).unwrap();
    fs::create_dir(directory_home.join(".env")).unwrap();
    let (_, result) = run_rust_setup(&project, &directory_home, None);
    assert!(
        result
            .unwrap_err()
            .to_string()
            .contains("not a regular file")
    );

    let public_home = root.path().join("public-home");
    fs::create_dir(&public_home).unwrap();
    fs::set_permissions(&public_home, fs::Permissions::from_mode(0o777)).unwrap();
    let (_, result) = run_rust_setup(&project, &public_home, None);
    assert!(
        result
            .unwrap_err()
            .to_string()
            .contains("unsafe permissions")
    );

    let public_config_home = root.path().join("public-config-home");
    fs::create_dir(&public_config_home).unwrap();
    fs::set_permissions(&public_config_home, fs::Permissions::from_mode(0o700)).unwrap();
    fs::write(public_config_home.join(".env"), INSTANCE_CONFIG_TEMPLATE).unwrap();
    fs::set_permissions(
        public_config_home.join(".env"),
        fs::Permissions::from_mode(0o644),
    )
    .unwrap();
    let (_, result) = run_rust_setup(&project, &public_config_home, None);
    assert!(
        result
            .unwrap_err()
            .to_string()
            .contains("must not be accessible")
    );

    let writable_ancestor_home = root.path().join("writable-ancestor-home");
    fs::create_dir_all(writable_ancestor_home.join("codex-workspace/.agents")).unwrap();
    fs::set_permissions(&writable_ancestor_home, fs::Permissions::from_mode(0o700)).unwrap();
    fs::set_permissions(
        writable_ancestor_home.join("codex-workspace"),
        fs::Permissions::from_mode(0o700),
    )
    .unwrap();
    fs::set_permissions(
        writable_ancestor_home.join("codex-workspace/.agents"),
        fs::Permissions::from_mode(0o777),
    )
    .unwrap();
    let (_, result) = run_rust_setup(&project, &writable_ancestor_home, None);
    assert!(
        result
            .unwrap_err()
            .to_string()
            .contains("unsafe permissions")
    );
}
