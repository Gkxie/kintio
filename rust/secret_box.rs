use std::fmt;

use aes_gcm::aead::consts::U12;
use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

const KEY_BYTES: usize = 32;
const NONCE_BYTES: usize = 12;
const AUTH_TAG_BYTES: usize = 16;
const MAX_SCOPE_BYTES: usize = 512;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IlinkSecretScope {
    pub secret_kind: String,
    pub account_id: String,
    pub peer_id: String,
    pub generation: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IlinkSealedSecret {
    pub nonce: String,
    pub ciphertext: String,
    pub auth_tag: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum IlinkSecretBoxErrorCode {
    InvalidKey,
    InvalidScope,
    InvalidSecret,
    InvalidEnvelope,
    DecryptionFailed,
    RandomnessFailed,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct IlinkSecretBoxError {
    pub code: IlinkSecretBoxErrorCode,
    message: &'static str,
}

impl IlinkSecretBoxError {
    const fn new(code: IlinkSecretBoxErrorCode, message: &'static str) -> Self {
        Self { code, message }
    }
}

impl fmt::Display for IlinkSecretBoxError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.message)
    }
}

impl std::error::Error for IlinkSecretBoxError {}

pub struct IlinkSecretBox {
    cipher: Aes256Gcm,
}

impl IlinkSecretBox {
    pub fn new(configured_key: &str) -> Result<Self, IlinkSecretBoxError> {
        let key = decode_configured_key(configured_key)?;
        let cipher = Aes256Gcm::new_from_slice(&key).map_err(|_| invalid_key())?;
        Ok(Self { cipher })
    }

    pub fn seal(
        &self,
        secret: &str,
        scope: &IlinkSecretScope,
    ) -> Result<IlinkSealedSecret, IlinkSecretBoxError> {
        validate_secret(secret)?;
        let aad = Zeroizing::new(additional_authenticated_data(scope)?);
        let mut nonce = Zeroizing::new([0_u8; NONCE_BYTES]);
        getrandom::fill(nonce.as_mut()).map_err(|_| {
            IlinkSecretBoxError::new(
                IlinkSecretBoxErrorCode::RandomnessFailed,
                "Unable to obtain iLink secret nonce randomness",
            )
        })?;
        self.encrypt_validated(secret, &aad, &nonce)
    }

    pub fn open(
        &self,
        envelope: &IlinkSealedSecret,
        scope: &IlinkSecretScope,
    ) -> Result<String, IlinkSecretBoxError> {
        let aad = Zeroizing::new(additional_authenticated_data(scope)?);
        let nonce = decode_envelope_field(&envelope.nonce, Some(NONCE_BYTES))?;
        let ciphertext = decode_envelope_field(&envelope.ciphertext, None)?;
        let auth_tag = decode_envelope_field(&envelope.auth_tag, Some(AUTH_TAG_BYTES))?;
        let nonce_bytes: [u8; NONCE_BYTES] = nonce
            .as_slice()
            .try_into()
            .map_err(|_| invalid_envelope())?;
        let nonce = Nonce::<U12>::from(nonce_bytes);
        let mut sealed = Zeroizing::new(Vec::with_capacity(
            ciphertext.len().saturating_add(auth_tag.len()),
        ));
        sealed.extend_from_slice(&ciphertext);
        sealed.extend_from_slice(&auth_tag);
        let plaintext = self
            .cipher
            .decrypt(
                &nonce,
                Payload {
                    msg: &sealed,
                    aad: &aad,
                },
            )
            .map_err(|_| {
                IlinkSecretBoxError::new(
                    IlinkSecretBoxErrorCode::DecryptionFailed,
                    "Unable to decrypt iLink secret",
                )
            })?;
        let plaintext = Zeroizing::new(plaintext);
        Ok(String::from_utf8_lossy(&plaintext).into_owned())
    }

    #[cfg(test)]
    pub(crate) fn seal_with_nonce(
        &self,
        secret: &str,
        scope: &IlinkSecretScope,
        nonce: &[u8; NONCE_BYTES],
    ) -> Result<IlinkSealedSecret, IlinkSecretBoxError> {
        validate_secret(secret)?;
        let aad = Zeroizing::new(additional_authenticated_data(scope)?);
        self.encrypt_validated(secret, &aad, nonce)
    }

    fn encrypt_validated(
        &self,
        secret: &str,
        aad: &[u8],
        nonce: &[u8; NONCE_BYTES],
    ) -> Result<IlinkSealedSecret, IlinkSecretBoxError> {
        let plaintext = Zeroizing::new(secret.as_bytes().to_vec());
        let aes_nonce = Nonce::<U12>::from(*nonce);
        let encrypted = self
            .cipher
            .encrypt(
                &aes_nonce,
                Payload {
                    msg: &plaintext,
                    aad,
                },
            )
            .map_err(|_| {
                IlinkSecretBoxError::new(
                    IlinkSecretBoxErrorCode::InvalidSecret,
                    "Unable to encrypt iLink secret",
                )
            })?;
        let split = encrypted
            .len()
            .checked_sub(AUTH_TAG_BYTES)
            .ok_or_else(invalid_envelope)?;
        let (ciphertext, auth_tag) = encrypted.split_at(split);
        Ok(IlinkSealedSecret {
            nonce: URL_SAFE_NO_PAD.encode(nonce),
            ciphertext: URL_SAFE_NO_PAD.encode(ciphertext),
            auth_tag: URL_SAFE_NO_PAD.encode(auth_tag),
        })
    }
}

fn invalid_key() -> IlinkSecretBoxError {
    IlinkSecretBoxError::new(
        IlinkSecretBoxErrorCode::InvalidKey,
        "iLink secret key must be a canonical 32-byte base64url value",
    )
}

fn invalid_envelope() -> IlinkSecretBoxError {
    IlinkSecretBoxError::new(
        IlinkSecretBoxErrorCode::InvalidEnvelope,
        "Invalid iLink secret envelope",
    )
}

fn validate_secret(secret: &str) -> Result<(), IlinkSecretBoxError> {
    if secret.is_empty() {
        return Err(IlinkSecretBoxError::new(
            IlinkSecretBoxErrorCode::InvalidSecret,
            "iLink secret must be a non-empty string",
        ));
    }
    Ok(())
}

fn decode_configured_key(value: &str) -> Result<Zeroizing<Vec<u8>>, IlinkSecretBoxError> {
    if value.len() != 43 || !is_base64url(value) {
        return Err(invalid_key());
    }
    let decoded = Zeroizing::new(URL_SAFE_NO_PAD.decode(value).map_err(|_| invalid_key())?);
    if decoded.len() != KEY_BYTES || URL_SAFE_NO_PAD.encode(&decoded) != value {
        return Err(invalid_key());
    }
    Ok(decoded)
}

fn decode_envelope_field(
    value: &str,
    expected_bytes: Option<usize>,
) -> Result<Zeroizing<Vec<u8>>, IlinkSecretBoxError> {
    if value.is_empty() || !is_base64url(value) {
        return Err(invalid_envelope());
    }
    let decoded = Zeroizing::new(
        URL_SAFE_NO_PAD
            .decode(value)
            .map_err(|_| invalid_envelope())?,
    );
    if URL_SAFE_NO_PAD.encode(&decoded) != value
        || expected_bytes.is_some_and(|expected| decoded.len() != expected)
    {
        return Err(invalid_envelope());
    }
    Ok(decoded)
}

fn is_base64url(value: &str) -> bool {
    value
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

pub(crate) fn additional_authenticated_data(
    scope: &IlinkSecretScope,
) -> Result<Vec<u8>, IlinkSecretBoxError> {
    if !valid_secret_kind(&scope.secret_kind)
        || !valid_scope_text(&scope.account_id)
        || !valid_scope_text(&scope.peer_id)
        || scope.generation > MAX_SAFE_INTEGER
    {
        return Err(IlinkSecretBoxError::new(
            IlinkSecretBoxErrorCode::InvalidScope,
            "Invalid iLink secret scope",
        ));
    }
    serde_json::to_vec(&(
        1,
        &scope.secret_kind,
        &scope.account_id,
        &scope.peer_id,
        scope.generation,
    ))
    .map_err(|_| {
        IlinkSecretBoxError::new(
            IlinkSecretBoxErrorCode::InvalidScope,
            "Invalid iLink secret scope",
        )
    })
}

fn valid_secret_kind(value: &str) -> bool {
    let bytes = value.as_bytes();
    matches!(bytes.first(), Some(b'a'..=b'z'))
        && bytes.len() <= 64
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'_')
}

fn valid_scope_text(value: &str) -> bool {
    !value.is_empty() && value.len() <= MAX_SCOPE_BYTES
}
