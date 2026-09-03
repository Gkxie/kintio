use std::fs;

fn main() {
    const PREFIX: &str = "export const KINTIO_VERSION = '";
    const SUFFIX: &str = "';";
    let source = fs::read_to_string("src/version.ts").expect("src/version.ts must be readable");
    let version = source
        .trim_end_matches(['\r', '\n'])
        .strip_prefix(PREFIX)
        .and_then(|value| value.strip_suffix(SUFFIX))
        .expect("src/version.ts must contain only the Kintio version");
    assert!(
        version.split('.').count() == 3
            && version
                .split('.')
                .all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit())),
        "Kintio version must be stable SemVer",
    );
    println!("cargo:rerun-if-changed=src/version.ts");
    println!("cargo:rustc-env=KINTIO_VERSION={version}");
}
