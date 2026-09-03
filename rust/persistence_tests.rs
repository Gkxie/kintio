use std::collections::BTreeMap;

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde::Deserialize;
use serde_json::Value;

use crate::persistence::{
    CanonicalValue, PersistenceCompatError, canonical_json, canonical_json_from_serde,
    stable_attempt_key, stable_client_message_id, stable_message_key,
};
use crate::secret_box::{
    IlinkSealedSecret, IlinkSecretBox, IlinkSecretBoxError, IlinkSecretBoxErrorCode,
    IlinkSecretScope, additional_authenticated_data,
};

const FIXTURE_SOURCE: &str = include_str!("../test/fixtures/persistence-compat-v1.json");

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Fixture {
    stable_ids: Vec<StableIdFixture>,
    canonical_json: Vec<CanonicalJsonFixture>,
    canonical_numbers: Vec<CanonicalNumberFixture>,
    secret_box: SecretBoxFixture,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StableIdFixture {
    channel: String,
    account_key: String,
    provider_message_id: String,
    send_index: u32,
    message_key: String,
    client_message_id: String,
    attempt_id: String,
}

#[derive(Debug, Deserialize)]
struct CanonicalJsonFixture {
    input: Value,
    encoded: String,
}

#[derive(Debug, Deserialize)]
struct CanonicalNumberFixture {
    input: String,
    encoded: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SecretBoxFixture {
    key: String,
    scope: IlinkSecretScope,
    secret: String,
    nonce: String,
    envelope: IlinkSealedSecret,
    aad: String,
}

fn fixture() -> Fixture {
    serde_json::from_str(FIXTURE_SOURCE).expect("compatibility fixture must be valid")
}

fn assert_secret_error<T>(
    result: Result<T, IlinkSecretBoxError>,
    expected: IlinkSecretBoxErrorCode,
) {
    assert!(
        result
            .as_ref()
            .err()
            .is_some_and(|error| error.code == expected),
        "secret-box operation returned an unexpected outcome",
    );
}

#[test]
fn stable_identifiers_match_the_typescript_fixture() {
    for vector in fixture().stable_ids {
        let message_key = stable_message_key(
            &vector.channel,
            &vector.account_key,
            &vector.provider_message_id,
        )
        .unwrap();
        assert_eq!(message_key, vector.message_key);
        assert_eq!(
            stable_client_message_id(&message_key, vector.send_index).unwrap(),
            vector.client_message_id,
        );
        assert_eq!(
            stable_attempt_key(&message_key, vector.send_index).unwrap(),
            vector.attempt_id,
        );
    }

    assert!(matches!(
        stable_message_key("unknown", "account", "message"),
        Err(PersistenceCompatError::UnsupportedChannel(_))
    ));
    assert!(matches!(
        stable_client_message_id("", 0),
        Err(PersistenceCompatError::MissingText("messageKey"))
    ));
}

#[test]
fn canonical_json_matches_ecmascript_bytes() {
    let fixture = fixture();
    for vector in fixture.canonical_json {
        assert_eq!(
            canonical_json_from_serde(vector.input).unwrap(),
            vector.encoded,
        );
    }
    for vector in fixture.canonical_numbers {
        let number = vector.input.parse::<f64>().unwrap();
        assert_eq!(
            canonical_json(&CanonicalValue::Number(number)).unwrap(),
            vector.encoded,
        );
    }

    let value = CanonicalValue::Object(BTreeMap::from([
        (
            "array".to_owned(),
            CanonicalValue::Array(vec![CanonicalValue::Undefined]),
        ),
        ("kept".to_owned(), CanonicalValue::Null),
        ("omitted".to_owned(), CanonicalValue::Undefined),
    ]));
    assert_eq!(
        canonical_json(&value).unwrap(),
        r#"{"array":[null],"kept":null}"#,
    );
    assert_eq!(
        canonical_json(&CanonicalValue::Number(f64::NAN)).unwrap_err(),
        PersistenceCompatError::NonFiniteNumber,
    );
}

#[test]
fn aes_gcm_fixture_is_byte_compatible_with_node() {
    let vector = fixture().secret_box;
    let box_ = IlinkSecretBox::new(&vector.key).unwrap();
    let nonce = URL_SAFE_NO_PAD.decode(&vector.nonce).unwrap();
    let nonce: [u8; 12] = nonce.try_into().unwrap();

    let aad = String::from_utf8(additional_authenticated_data(&vector.scope).unwrap()).unwrap();
    assert!(
        aad == vector.aad,
        "the authenticated-data bytes do not match the compatibility fixture",
    );
    assert_eq!(
        box_.seal_with_nonce(&vector.secret, &vector.scope, &nonce)
            .unwrap(),
        vector.envelope,
    );
    let opened = box_.open(&vector.envelope, &vector.scope);
    assert!(
        opened.as_ref().is_ok_and(|value| value == &vector.secret),
        "the fixed envelope did not open to the expected secret",
    );
}

#[test]
fn aes_gcm_scope_envelope_and_key_validation_fail_closed() {
    let vector = fixture().secret_box;
    let box_ = IlinkSecretBox::new(&vector.key).unwrap();

    for scope in [
        IlinkSecretScope {
            secret_kind: "bot_token".to_owned(),
            ..vector.scope.clone()
        },
        IlinkSecretScope {
            account_id: "another-account".to_owned(),
            ..vector.scope.clone()
        },
        IlinkSecretScope {
            peer_id: "another-peer".to_owned(),
            ..vector.scope.clone()
        },
        IlinkSecretScope {
            generation: vector.scope.generation + 1,
            ..vector.scope.clone()
        },
    ] {
        assert_secret_error(
            box_.open(&vector.envelope, &scope),
            IlinkSecretBoxErrorCode::DecryptionFailed,
        );
    }

    for envelope in [
        IlinkSealedSecret {
            nonce: "not+padded=".to_owned(),
            ..vector.envelope.clone()
        },
        IlinkSealedSecret {
            ciphertext: String::new(),
            ..vector.envelope.clone()
        },
        IlinkSealedSecret {
            auth_tag: "AA".to_owned(),
            ..vector.envelope.clone()
        },
    ] {
        assert_secret_error(
            box_.open(&envelope, &vector.scope),
            IlinkSecretBoxErrorCode::InvalidEnvelope,
        );
    }

    let noncanonical_tag = IlinkSealedSecret {
        auth_tag: format!(
            "{}B",
            &vector.envelope.auth_tag[..vector.envelope.auth_tag.len() - 1]
        ),
        ..vector.envelope.clone()
    };
    assert_secret_error(
        box_.open(&noncanonical_tag, &vector.scope),
        IlinkSecretBoxErrorCode::InvalidEnvelope,
    );

    for envelope in [
        IlinkSealedSecret {
            nonce: changed_canonical_field(&vector.envelope.nonce),
            ..vector.envelope.clone()
        },
        IlinkSealedSecret {
            ciphertext: changed_canonical_field(&vector.envelope.ciphertext),
            ..vector.envelope.clone()
        },
        IlinkSealedSecret {
            auth_tag: changed_canonical_field(&vector.envelope.auth_tag),
            ..vector.envelope.clone()
        },
    ] {
        assert_secret_error(
            box_.open(&envelope, &vector.scope),
            IlinkSecretBoxErrorCode::DecryptionFailed,
        );
    }

    let another_key = changed_canonical_field(&vector.key);
    assert_secret_error(
        IlinkSecretBox::new(&another_key)
            .unwrap()
            .open(&vector.envelope, &vector.scope),
        IlinkSecretBoxErrorCode::DecryptionFailed,
    );

    for key in [
        String::new(),
        URL_SAFE_NO_PAD.encode([0_u8; 31]),
        format!("{}=", URL_SAFE_NO_PAD.encode([0_u8; 32])),
        format!("{}B", &URL_SAFE_NO_PAD.encode([0_u8; 32])[..42]),
    ] {
        assert_secret_error(
            IlinkSecretBox::new(&key),
            IlinkSecretBoxErrorCode::InvalidKey,
        );
    }

    let nonce = [7_u8; 12];
    let boundary_scope = IlinkSecretScope {
        secret_kind: "context_token".to_owned(),
        account_id: "a".repeat(512),
        peer_id: "p".repeat(512),
        generation: 9_007_199_254_740_991,
    };
    assert!(
        box_.seal_with_nonce("boundary", &boundary_scope, &nonce)
            .is_ok()
    );
    let utf8_boundary_scope = IlinkSecretScope {
        account_id: "😀".repeat(128),
        ..boundary_scope.clone()
    };
    assert!(
        box_.seal_with_nonce("boundary", &utf8_boundary_scope, &nonce)
            .is_ok()
    );
    let secret_kind_boundary_scope = IlinkSecretScope {
        secret_kind: format!("a{}", "b".repeat(63)),
        ..boundary_scope.clone()
    };
    assert!(
        box_.seal_with_nonce("boundary", &secret_kind_boundary_scope, &nonce)
            .is_ok()
    );
    for scope in [
        IlinkSecretScope {
            account_id: "a".repeat(513),
            ..boundary_scope.clone()
        },
        IlinkSecretScope {
            peer_id: String::new(),
            ..boundary_scope.clone()
        },
        IlinkSecretScope {
            account_id: "😀".repeat(129),
            ..boundary_scope.clone()
        },
        IlinkSecretScope {
            secret_kind: "Invalid".to_owned(),
            ..boundary_scope.clone()
        },
        IlinkSecretScope {
            secret_kind: format!("a{}", "b".repeat(64)),
            ..boundary_scope.clone()
        },
        IlinkSecretScope {
            generation: 9_007_199_254_740_992,
            ..boundary_scope.clone()
        },
    ] {
        assert_secret_error(
            box_.seal_with_nonce("boundary", &scope, &nonce),
            IlinkSecretBoxErrorCode::InvalidScope,
        );
    }
    assert_secret_error(
        box_.seal_with_nonce("", &boundary_scope, &nonce),
        IlinkSecretBoxErrorCode::InvalidSecret,
    );
}

fn changed_canonical_field(value: &str) -> String {
    let mut decoded = URL_SAFE_NO_PAD.decode(value).unwrap();
    decoded[0] ^= 1;
    URL_SAFE_NO_PAD.encode(decoded)
}
