use std::collections::BTreeMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};

use anyhow::{Result, bail};

use crate::setup::absolute_path;
#[cfg(windows)]
use crate::setup::is_path_inside;

const MAX_SHUTDOWN_TIMEOUT_MS: u64 = 120_000;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

pub(crate) fn validate_setup_config(
    source: &str,
    inherited: &BTreeMap<OsString, OsString>,
    home: &Path,
) -> Result<PathBuf> {
    let mut environment = BTreeMap::<String, String>::new();
    for (name, value) in inherited {
        let (Some(name), Some(value)) = (name.to_str(), value.to_str()) else {
            continue;
        };
        environment.insert(normalize_name(name), value.to_owned());
    }
    for (name, value) in parse_env(source) {
        environment.entry(normalize_name(&name)).or_insert(value);
    }

    parse_port(value(&environment, "PORT"))?;
    let callback_token = value(&environment, "WECOM_CALLBACK_TOKEN").unwrap_or("");
    let encoding_key = value(&environment, "WECOM_ENCODING_AES_KEY").unwrap_or("");
    if callback_token.is_empty() != encoding_key.is_empty() {
        bail!("WECOM_CALLBACK_TOKEN and WECOM_ENCODING_AES_KEY must be configured together");
    }
    if !callback_token.is_empty()
        && (callback_token.len() > 32 || !callback_token.bytes().all(is_ascii_alphanumeric))
    {
        bail!("WECOM_CALLBACK_TOKEN must contain 1 to 32 letters or digits");
    }
    if !encoding_key.is_empty()
        && (encoding_key.len() != 43 || !encoding_key.bytes().all(is_ascii_alphanumeric))
    {
        bail!("WECOM_ENCODING_AES_KEY must contain 43 letters or digits");
    }

    let corp_id = value(&environment, "WECOM_CORP_ID").unwrap_or("").trim();
    let kf_secret = value(&environment, "WECOM_KF_SECRET").unwrap_or("").trim();
    if corp_id.is_empty() != kf_secret.is_empty() {
        bail!("WECOM_CORP_ID and WECOM_KF_SECRET must be configured together");
    }
    let api_enabled = !corp_id.is_empty() && !kf_secret.is_empty();
    if api_enabled
        && value(&environment, "ILINK_ENABLED")
            .unwrap_or("")
            .trim()
            .is_empty()
    {
        bail!("ILINK_ENABLED must be explicitly true or false when WeChat KF API is enabled");
    }
    let ilink_enabled = parse_boolean(value(&environment, "ILINK_ENABLED"), false)?;
    parse_boolean(
        value(&environment, "CODEX_ENABLED"),
        api_enabled || ilink_enabled,
    )?;

    let storage_key = value(&environment, "ILINK_STORAGE_KEY")
        .unwrap_or("")
        .trim();
    if !storage_key.is_empty()
        && (storage_key.len() != 43
            || !storage_key
                .bytes()
                .all(|byte| is_ascii_alphanumeric(byte) || byte == b'_' || byte == b'-'))
    {
        bail!("ILINK_STORAGE_KEY must be a canonical 32-byte base64url value");
    }
    parse_positive_integer(
        value(&environment, "ILINK_API_TIMEOUT_MS"),
        15_000,
        "ILINK_API_TIMEOUT_MS",
        120_000,
    )?;
    parse_positive_integer(
        value(&environment, "ILINK_LONG_POLL_TIMEOUT_MS"),
        35_000,
        "ILINK_LONG_POLL_TIMEOUT_MS",
        120_000,
    )?;
    parse_positive_integer(
        value(&environment, "ILINK_MAX_ACCOUNTS"),
        20,
        "ILINK_MAX_ACCOUNTS",
        1_000,
    )?;
    parse_positive_integer(
        value(&environment, "WECOM_API_TIMEOUT_MS"),
        10_000,
        "WECOM_API_TIMEOUT_MS",
        120_000,
    )?;
    parse_positive_integer(
        value(&environment, "WECOM_MCP_OBSERVE_MS"),
        5_000,
        "WECOM_MCP_OBSERVE_MS",
        20_000,
    )?;
    parse_positive_integer(
        value(&environment, "WECOM_AUTH_TRIGGER_COUNT"),
        3,
        "WECOM_AUTH_TRIGGER_COUNT",
        MAX_SAFE_INTEGER,
    )?;
    let shutdown_timeout = parse_positive_integer(
        value(&environment, "SHUTDOWN_TIMEOUT_MS"),
        10_000,
        "SHUTDOWN_TIMEOUT_MS",
        MAX_SHUTDOWN_TIMEOUT_MS,
    )?;
    if shutdown_timeout < 1_000 {
        bail!("SHUTDOWN_TIMEOUT_MS must be at least 1000");
    }

    if value(&environment, "WECOM_ALLOWED_USER_IDS")
        .unwrap_or("")
        .split(',')
        .map(str::trim)
        .any(|entry| entry == "*")
    {
        bail!("WECOM_ALLOWED_USER_IDS does not support wildcard entries");
    }
    bounded_text(
        value(&environment, "WECOM_AUTH_TRIGGER"),
        "WECOM_AUTH_TRIGGER",
        128,
    )?;
    bounded_text(
        value(&environment, "WECOM_AUTH_CONFIRMATION"),
        "WECOM_AUTH_CONFIRMATION",
        2_048,
    )?;

    let (database_file, lock_name) = resolve_database_file(&environment, home)?;
    let lock_file = database_file.parent().unwrap_or(home).join(lock_name);
    let storage_key_file = absolute_path(
        home,
        Path::new(value(&environment, "ILINK_STORAGE_KEY_FILE").unwrap_or("")),
    );
    let storage_key_file = if value(&environment, "ILINK_STORAGE_KEY_FILE")
        .is_some_and(|configured| !configured.is_empty())
    {
        storage_key_file
    } else {
        database_file
            .parent()
            .unwrap_or(home)
            .join("ilink-storage.key")
    };
    let working_directory = absolute_path(
        home,
        Path::new(
            value(&environment, "CODEX_WORKING_DIRECTORY")
                .filter(|configured| !configured.is_empty())
                .unwrap_or("codex-workspace"),
        ),
    );
    let image_directory = absolute_path(
        home,
        Path::new(
            value(&environment, "CODEX_IMAGE_TMP_DIR")
                .filter(|configured| !configured.is_empty())
                .unwrap_or("data/codex-input"),
        ),
    );

    #[cfg(windows)]
    for (name, path) in [
        ("KINTIO_DB_FILE", &database_file),
        ("Kintio state lock", &lock_file),
        ("ILINK_STORAGE_KEY_FILE", &storage_key_file),
        ("CODEX_IMAGE_TMP_DIR", &image_directory),
    ] {
        if !is_path_inside(home, path)? {
            bail!("{name} must stay inside KINTIO_HOME on Windows");
        }
    }
    #[cfg(not(windows))]
    let _ = (lock_file, storage_key_file, image_directory);

    Ok(working_directory)
}

fn parse_env(source: &str) -> BTreeMap<String, String> {
    let bytes = source.as_bytes();
    let mut values = BTreeMap::new();
    let mut index = if bytes.starts_with(&[0xef, 0xbb, 0xbf]) {
        3
    } else {
        0
    };
    while index < bytes.len() {
        while index < bytes.len() && matches!(bytes[index], b' ' | b'\t' | b'\r' | b'\n') {
            index += 1;
        }
        if index >= bytes.len() {
            break;
        }
        if bytes[index] == b'#' {
            index = next_line(bytes, index);
            continue;
        }
        if bytes[index..].starts_with(b"export")
            && bytes
                .get(index + 6)
                .is_some_and(|byte| matches!(byte, b' ' | b'\t'))
        {
            index += 6;
            while index < bytes.len() && matches!(bytes[index], b' ' | b'\t') {
                index += 1;
            }
        }
        let name_start = index;
        while index < bytes.len() && !matches!(bytes[index], b'=' | b'\r' | b'\n') {
            index += 1;
        }
        if bytes.get(index) != Some(&b'=') {
            index = next_line(bytes, index);
            continue;
        }
        let name = String::from_utf8_lossy(&bytes[name_start..index])
            .trim()
            .to_owned();
        index += 1;
        while index < bytes.len() && matches!(bytes[index], b' ' | b'\t') {
            index += 1;
        }
        let value_start = index;
        let value = if let Some(quote @ (b'\'' | b'"' | b'`')) = bytes.get(index).copied() {
            index += 1;
            let content_start = index;
            while index < bytes.len() && bytes[index] != quote {
                index += 1;
            }
            if index == bytes.len() {
                String::from_utf8_lossy(&bytes[value_start..index]).into_owned()
            } else {
                let mut result = String::from_utf8_lossy(&bytes[content_start..index]).into_owned();
                if quote == b'"' {
                    result = result.replace("\\n", "\n");
                }
                index += 1;
                result
            }
        } else {
            while index < bytes.len() && !matches!(bytes[index], b'#' | b'\r' | b'\n') {
                index += 1;
            }
            String::from_utf8_lossy(&bytes[value_start..index])
                .trim()
                .to_owned()
        };
        if !name.is_empty() {
            values.insert(name, value);
        }
        index = next_line(bytes, index);
    }
    values
}

fn next_line(bytes: &[u8], mut index: usize) -> usize {
    while index < bytes.len() && !matches!(bytes[index], b'\r' | b'\n') {
        index += 1;
    }
    while index < bytes.len() && matches!(bytes[index], b'\r' | b'\n') {
        index += 1;
    }
    index
}

fn resolve_database_file(
    environment: &BTreeMap<String, String>,
    home: &Path,
) -> Result<(PathBuf, &'static str)> {
    for name in [
        "KINTIO_DB_FILE",
        "TALKFERRY_DB_FILE",
        "HARNESS_DB_FILE",
        "WECOM_DB_FILE",
    ] {
        if let Some(configured) = value(environment, name).filter(|value| !value.is_empty()) {
            let database = absolute_path(home, Path::new(configured));
            let lock = if database == home.join("data/wecom.sqlite")
                || matches!(name, "HARNESS_DB_FILE" | "WECOM_DB_FILE")
            {
                "wecom.lock"
            } else if database == home.join("data/talkferry.sqlite") || name == "TALKFERRY_DB_FILE"
            {
                "talkferry.lock"
            } else {
                "kintio.lock"
            };
            return Ok((database, lock));
        }
    }
    let candidates = [
        home.join("data/kintio.sqlite"),
        home.join("data/talkferry.sqlite"),
        home.join("data/wecom.sqlite"),
    ];
    let existing = candidates.iter().filter(|file| file.exists()).count();
    if existing > 1 {
        bail!("Multiple default state databases exist; set KINTIO_DB_FILE explicitly");
    }
    let database = candidates
        .into_iter()
        .find(|file| file.exists())
        .unwrap_or_else(|| home.join("data/kintio.sqlite"));
    let lock = if database.ends_with("talkferry.sqlite") {
        "talkferry.lock"
    } else if database.ends_with("wecom.sqlite") {
        "wecom.lock"
    } else {
        "kintio.lock"
    };
    Ok((database, lock))
}

fn normalize_name(name: &str) -> String {
    if cfg!(windows) {
        name.to_ascii_uppercase()
    } else {
        name.to_owned()
    }
}

fn value<'a>(environment: &'a BTreeMap<String, String>, name: &str) -> Option<&'a str> {
    environment.get(&normalize_name(name)).map(String::as_str)
}

fn parse_port(value: Option<&str>) -> Result<u16> {
    let parsed = parse_integer(value.unwrap_or("8888"))
        .map_err(|_| anyhow::anyhow!("PORT must be an integer between 1 and 65535"))?;
    if !(1..=65_535).contains(&parsed) {
        bail!("PORT must be an integer between 1 and 65535");
    }
    Ok(u16::try_from(parsed).expect("validated port fits u16"))
}

fn parse_boolean(value: Option<&str>, fallback: bool) -> Result<bool> {
    let Some(value) = value.filter(|value| !value.is_empty()) else {
        return Ok(fallback);
    };
    if ["1", "true", "yes", "on"]
        .iter()
        .any(|candidate| value.eq_ignore_ascii_case(candidate))
    {
        return Ok(true);
    }
    if ["0", "false", "no", "off"]
        .iter()
        .any(|candidate| value.eq_ignore_ascii_case(candidate))
    {
        return Ok(false);
    }
    bail!("Invalid boolean value: {value}")
}

fn parse_positive_integer(
    value: Option<&str>,
    fallback: u64,
    name: &str,
    maximum: u64,
) -> Result<u64> {
    let parsed = match value {
        Some(value) => parse_integer(value),
        None => Ok(i128::from(fallback)),
    }
    .map_err(|_| anyhow::anyhow!("{name} must be a positive integer"))?;
    if parsed < 1 {
        bail!("{name} must be a positive integer");
    }
    let parsed = u64::try_from(parsed).map_err(|_| anyhow::anyhow!("{name} is too large"))?;
    if parsed > maximum {
        bail!("{name} must not exceed {maximum}");
    }
    Ok(parsed)
}

fn parse_integer(value: &str) -> Result<i128> {
    let number = value.trim().parse::<f64>()?;
    if !number.is_finite()
        || number.fract() != 0.0
        || number < i128::MIN as f64
        || number > i128::MAX as f64
    {
        bail!("not an integer");
    }
    let integer = number as i128;
    if integer as f64 != number {
        bail!("integer is outside the exact range");
    }
    Ok(integer)
}

fn bounded_text(value: Option<&str>, name: &str, maximum: usize) -> Result<()> {
    if value.unwrap_or("").len() > maximum {
        bail!("{name} must not exceed {maximum} UTF-8 bytes");
    }
    Ok(())
}

const fn is_ascii_alphanumeric(byte: u8) -> bool {
    byte.is_ascii_alphanumeric()
}

#[cfg(test)]
mod tests {
    use super::parse_env;

    #[test]
    fn parses_node_style_values() {
        let source = "A=one two # note\nA=last\nB=\"line\\nnext\" # note\nC='a # b'\n\
                      D=\"C:\\repo\"\nE=\"literal\\rtab\\t\"\n";
        let parsed = parse_env(source);
        assert_eq!(parsed.get("A").map(String::as_str), Some("last"));
        assert_eq!(parsed.get("B").map(String::as_str), Some("line\nnext"));
        assert_eq!(parsed.get("C").map(String::as_str), Some("a # b"));
        assert_eq!(parsed.get("D").map(String::as_str), Some(r"C:\repo"));
        assert_eq!(parsed.get("E").map(String::as_str), Some(r"literal\rtab\t"));
    }
}
