use std::fs;
use std::process::{Command, Output};

use kintio_native::INSTANCE_CONFIG_TEMPLATE;
use tempfile::TempDir;

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

fn remove_config_environment(command: &mut Command) {
    for name in CONFIG_ENVIRONMENT_NAMES {
        command.env_remove(name);
    }
}

fn rust_cli(arguments: &[&str]) -> Output {
    let mut command = Command::new(env!("CARGO_BIN_EXE_kintio-rs"));
    remove_config_environment(&mut command);
    command.args(arguments).output().expect("native CLI starts")
}

fn typescript_cli(arguments: &[&str]) -> Output {
    let mut command = Command::new("node");
    remove_config_environment(&mut command);
    command
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .arg("--experimental-strip-types")
        .arg("cli.ts")
        .args(arguments)
        .output()
        .expect("TypeScript CLI starts")
}

#[test]
fn process_help_and_version_keep_public_exit_semantics() {
    for arguments in [
        Vec::new(),
        vec!["--help"],
        vec!["setup", "--help"],
        vec!["--home", "ignored-without-a-command"],
    ] {
        let output = rust_cli(&arguments);
        assert!(output.status.success());
        assert!(output.stderr.is_empty());
        assert!(
            String::from_utf8(output.stdout)
                .unwrap()
                .contains("Usage: kintio-rs")
        );
    }

    for arguments in [vec!["--version"], vec!["-v"], vec!["setup", "--version"]] {
        let output = rust_cli(&arguments);
        assert!(output.status.success());
        assert!(output.stderr.is_empty());
        assert_eq!(
            String::from_utf8(output.stdout).unwrap(),
            format!("{}\n", env!("KINTIO_VERSION")),
        );
    }

    for arguments in [vec!["-V"], vec!["--unknown", "--version"]] {
        let output = rust_cli(&arguments);
        assert!(!output.status.success());
        assert!(output.stdout.is_empty());
        assert!(!output.stderr.is_empty());
    }
}

#[test]
fn invalid_existing_config_fails_before_installing_a_skill() {
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;

    let invalid = [
        ("PORT=8888", "PORT=0", "PORT"),
        (
            "WECOM_CALLBACK_TOKEN=",
            "WECOM_CALLBACK_TOKEN=token",
            "configured together",
        ),
        ("ILINK_ENABLED=false", "ILINK_ENABLED=perhaps", "boolean"),
        (
            "# ILINK_API_TIMEOUT_MS=15000",
            "ILINK_API_TIMEOUT_MS=0",
            "positive integer",
        ),
        (
            "WECOM_ALLOWED_USER_IDS=",
            "WECOM_ALLOWED_USER_IDS=*",
            "wildcard",
        ),
        (
            "# SHUTDOWN_TIMEOUT_MS=10000",
            "SHUTDOWN_TIMEOUT_MS=999",
            "at least 1000",
        ),
    ];
    for (before, after, expected) in invalid {
        let config = INSTANCE_CONFIG_TEMPLATE.replace(before, after);
        for runner in [rust_cli as fn(&[&str]) -> Output, typescript_cli] {
            let root = TempDir::new().unwrap();
            let home = root.path().join("instance");
            fs::create_dir(&home).unwrap();
            #[cfg(unix)]
            fs::set_permissions(&home, fs::Permissions::from_mode(0o700)).unwrap();
            fs::write(home.join(".env"), &config).unwrap();
            #[cfg(unix)]
            fs::set_permissions(home.join(".env"), fs::Permissions::from_mode(0o600)).unwrap();
            let home = home.to_str().unwrap();
            let output = runner(&["setup", "--home", home]);
            assert!(!output.status.success(), "{before} -> {after}");
            assert!(
                String::from_utf8_lossy(&output.stderr).contains(expected),
                "{}",
                String::from_utf8_lossy(&output.stderr),
            );
            assert!(!root.path().join("instance/codex-workspace").exists());
        }
    }
}

#[test]
fn quoted_config_values_match_the_typescript_setup_boundary() {
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;

    for runner in [rust_cli as fn(&[&str]) -> Output, typescript_cli] {
        let root = TempDir::new().unwrap();
        let home = root.path().join("instance");
        fs::create_dir(&home).unwrap();
        #[cfg(unix)]
        fs::set_permissions(&home, fs::Permissions::from_mode(0o700)).unwrap();
        fs::write(
            home.join(".env"),
            "PORT=8888\nILINK_ENABLED=false\nCODEX_ENABLED=true\n\
             CODEX_WORKING_DIRECTORY=\".\\repo home\" # operator note\n",
        )
        .unwrap();
        #[cfg(unix)]
        fs::set_permissions(home.join(".env"), fs::Permissions::from_mode(0o600)).unwrap();
        let output = runner(&["setup", "--home", home.to_str().unwrap()]);
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(
            home.join(r".\repo home")
                .join(".agents")
                .join("skills")
                .join("wechat-kf-reply-sop")
                .join("SKILL.md")
                .is_file()
        );
    }
}

#[test]
fn empty_working_directory_uses_the_default_for_both_runtimes() {
    for runner in [rust_cli as fn(&[&str]) -> Output, typescript_cli] {
        let root = TempDir::new().unwrap();
        let home = root.path().join("instance");
        fs::create_dir(&home).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&home, fs::Permissions::from_mode(0o700)).unwrap();
        }
        fs::write(
            home.join(".env"),
            "PORT=8888\nILINK_ENABLED=false\nCODEX_ENABLED=true\n\
             CODEX_WORKING_DIRECTORY=\nCODEX_IMAGE_TMP_DIR=\n",
        )
        .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(home.join(".env"), fs::Permissions::from_mode(0o600)).unwrap();
        }

        let output = runner(&["setup", "--home", home.to_str().unwrap()]);
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(
            home.join("codex-workspace")
                .join(".agents")
                .join("skills")
                .join("wechat-kf-reply-sop")
                .join("SKILL.md")
                .is_file()
        );
    }
}

#[test]
fn default_and_explicit_empty_locations_use_the_controlled_user_profile() {
    for arguments in [
        vec!["setup"],
        vec!["setup", "--home", ""],
        vec!["setup", "--config", ""],
    ] {
        for native in [true, false] {
            let profile = TempDir::new().unwrap();
            let mut command = if native {
                Command::new(env!("CARGO_BIN_EXE_kintio-rs"))
            } else {
                let mut command = Command::new("node");
                command
                    .current_dir(env!("CARGO_MANIFEST_DIR"))
                    .arg("--experimental-strip-types")
                    .arg("cli.ts");
                command
            };
            remove_config_environment(&mut command);
            let output = command
                .args(&arguments)
                .env("HOME", profile.path())
                .env("USERPROFILE", profile.path())
                .output()
                .expect("setup process starts");
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            assert_eq!(
                fs::read_to_string(profile.path().join(".kintio").join(".env")).unwrap(),
                INSTANCE_CONFIG_TEMPLATE,
            );
        }
    }
}

#[cfg(unix)]
#[test]
fn an_explicitly_empty_process_home_uses_the_current_directory() {
    for native in [true, false] {
        let working_directory = TempDir::new().unwrap();
        let mut command = if native {
            Command::new(env!("CARGO_BIN_EXE_kintio-rs"))
        } else {
            let mut command = Command::new("node");
            command
                .arg("--experimental-strip-types")
                .arg(format!("{}/cli.ts", env!("CARGO_MANIFEST_DIR")));
            command
        };
        remove_config_environment(&mut command);
        let output = command
            .current_dir(working_directory.path())
            .arg("setup")
            .env("HOME", "")
            .output()
            .expect("setup process starts");
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(
            fs::read_to_string(working_directory.path().join(".kintio").join(".env")).unwrap(),
            INSTANCE_CONFIG_TEMPLATE,
        );
    }
}
