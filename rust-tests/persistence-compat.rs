use std::io::Write;
use std::process::{Command, Stdio};

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use kintio_native::{IlinkSealedSecret, IlinkSecretBox, IlinkSecretScope};
use serde_json::{Value, json};

const NODE_ORACLE: &str = r#"
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const source = await new Promise((resolve, reject) => {
  let value = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { value += chunk; });
  process.stdin.on('end', () => resolve(value));
  process.stdin.on('error', reject);
});
const input = JSON.parse(source);
const moduleUrl = pathToFileURL(
  path.join(process.cwd(), 'src/ilink/secret-box.ts'),
).href;
const { IlinkSecretBox } = await import(moduleUrl);
const result = input.operation === 'sealBatch'
  ? {
      envelopes: input.items.map((item) =>
        new IlinkSecretBox(item.key).seal(item.secret, item.scope)
      ),
    }
  : {
      matches: input.items.map((item) =>
        new IlinkSecretBox(item.key).open(item.envelope, item.scope) === item.secret
      ),
    };
process.stdout.write(JSON.stringify(result));
"#;

struct CrossLanguageCase {
    key: String,
    scope: IlinkSecretScope,
    secret: String,
}

fn node_oracle(input: &Value) -> Value {
    let mut child = Command::new("node")
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .args([
            "--experimental-strip-types",
            "--input-type=module",
            "--eval",
            NODE_ORACLE,
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("Node compatibility Oracle starts");
    child
        .stdin
        .take()
        .expect("Oracle stdin is piped")
        .write_all(&serde_json::to_vec(input).unwrap())
        .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "Node compatibility Oracle failed: {}",
        String::from_utf8_lossy(&output.stderr),
    );
    serde_json::from_slice(&output.stdout).expect("Oracle output is JSON")
}

#[test]
fn node_and_rust_open_each_others_fresh_envelopes() {
    let fixed_key = URL_SAFE_NO_PAD.encode([0_u8; 32]);
    let mut cases = vec![
        CrossLanguageCase {
            key: fixed_key.clone(),
            scope: IlinkSecretScope {
                secret_kind: "bot_token".to_owned(),
                account_id: "ia_1111111111111111111111111111111111111111".to_owned(),
                peer_id: "user-one@im.wechat".to_owned(),
                generation: 0,
            },
            secret: "ASCII token".to_owned(),
        },
        CrossLanguageCase {
            key: fixed_key.clone(),
            scope: IlinkSecretScope {
                secret_kind: "context_token".to_owned(),
                account_id: "ia_2222222222222222222222222222222222222222".to_owned(),
                peer_id: "用户-乙😀@im.wechat".to_owned(),
                generation: 9_007_199_254_740_991,
            },
            secret: "多语言 secret 🔐\nsecond line".to_owned(),
        },
        CrossLanguageCase {
            key: fixed_key,
            scope: IlinkSecretScope {
                secret_kind: "context_token".to_owned(),
                account_id: "quote\" slash\\ newline\nseparator\u{2028}".to_owned(),
                peer_id: "peer\"\\\n\u{2028}".to_owned(),
                generation: 7,
            },
            secret: "AAD escaping boundary".to_owned(),
        },
    ];
    for index in 0..4 {
        let mut key = [0_u8; 32];
        let mut secret = [0_u8; 24];
        getrandom::fill(&mut key).unwrap();
        getrandom::fill(&mut secret).unwrap();
        cases.push(CrossLanguageCase {
            key: URL_SAFE_NO_PAD.encode(key),
            scope: IlinkSecretScope {
                secret_kind: "context_token".to_owned(),
                account_id: format!("ia_{index:040x}"),
                peer_id: format!("random-user-{index}@im.wechat"),
                generation: index,
            },
            secret: format!("随机-{index}-{}", URL_SAFE_NO_PAD.encode(secret)),
        });
    }

    let seal_items = cases
        .iter()
        .map(|case| {
            json!({
                "key": case.key,
                "scope": case.scope,
                "secret": case.secret,
            })
        })
        .collect::<Vec<_>>();
    let node = node_oracle(&json!({
        "operation": "sealBatch",
        "items": seal_items,
    }));
    let node_envelopes = node["envelopes"]
        .as_array()
        .expect("Node returned an envelope array");
    assert_eq!(node_envelopes.len(), cases.len());

    let mut open_items = Vec::with_capacity(cases.len());
    for (case, envelope) in cases.iter().zip(node_envelopes) {
        let envelope: IlinkSealedSecret = serde_json::from_value(envelope.clone()).unwrap();
        let box_ = IlinkSecretBox::new(&case.key).unwrap();
        let opened = box_.open(&envelope, &case.scope);
        assert!(
            opened.as_ref().is_ok_and(|value| value == &case.secret),
            "Rust could not open a fresh Node envelope",
        );

        open_items.push(json!({
            "key": case.key,
            "scope": case.scope,
            "secret": case.secret,
            "envelope": box_.seal(&case.secret, &case.scope).unwrap(),
        }));
    }
    let node = node_oracle(&json!({
        "operation": "openBatch",
        "items": open_items,
    }));
    assert!(
        node["matches"].as_array().is_some_and(
            |values| values.len() == cases.len() && values.iter().all(Value::is_boolean)
        ),
        "Node returned an invalid comparison result",
    );
    assert!(
        node["matches"]
            .as_array()
            .is_some_and(|values| values.iter().all(|value| value.as_bool() == Some(true))),
        "Node could not open a fresh Rust envelope",
    );
}
