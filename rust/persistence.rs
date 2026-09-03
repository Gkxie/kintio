use std::collections::BTreeMap;
use std::fmt::{self, Write as _};

use serde_json::Value;
use sha2::{Digest, Sha256};

const MESSAGE_KEY_HEX_LENGTH: usize = 40;
const SEND_KEY_HEX_LENGTH: usize = 29;

#[derive(Clone, Debug, PartialEq)]
pub enum CanonicalValue {
    Undefined,
    Null,
    Boolean(bool),
    Number(f64),
    String(String),
    Array(Vec<Self>),
    Object(BTreeMap<String, Self>),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PersistenceCompatError {
    MissingText(&'static str),
    UnsupportedChannel(String),
    NonFiniteNumber,
    JsonEncoding,
}

impl fmt::Display for PersistenceCompatError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::MissingText(name) => write!(formatter, "{name} is required"),
            Self::UnsupportedChannel(channel) => {
                write!(formatter, "Unsupported chat channel: {channel}")
            }
            Self::NonFiniteNumber => formatter.write_str("JSON numbers must be finite"),
            Self::JsonEncoding => formatter.write_str("Unable to encode canonical JSON string"),
        }
    }
}

impl std::error::Error for PersistenceCompatError {}

impl TryFrom<Value> for CanonicalValue {
    type Error = PersistenceCompatError;

    fn try_from(value: Value) -> Result<Self, Self::Error> {
        match value {
            Value::Null => Ok(Self::Null),
            Value::Bool(value) => Ok(Self::Boolean(value)),
            Value::Number(value) => value
                .as_f64()
                .filter(|value| value.is_finite())
                .map(Self::Number)
                .ok_or(PersistenceCompatError::NonFiniteNumber),
            Value::String(value) => Ok(Self::String(value)),
            Value::Array(values) => values
                .into_iter()
                .map(Self::try_from)
                .collect::<Result<Vec<_>, _>>()
                .map(Self::Array),
            Value::Object(values) => values
                .into_iter()
                .map(|(key, value)| Self::try_from(value).map(|value| (key, value)))
                .collect::<Result<BTreeMap<_, _>, _>>()
                .map(Self::Object),
        }
    }
}

pub fn canonical_json(value: &CanonicalValue) -> Result<String, PersistenceCompatError> {
    let mut output = String::new();
    write_canonical_value(value, &mut output)?;
    Ok(output)
}

pub fn canonical_json_from_serde(value: Value) -> Result<String, PersistenceCompatError> {
    canonical_json(&CanonicalValue::try_from(value)?)
}

fn write_canonical_value(
    value: &CanonicalValue,
    output: &mut String,
) -> Result<(), PersistenceCompatError> {
    match value {
        CanonicalValue::Undefined | CanonicalValue::Null => output.push_str("null"),
        CanonicalValue::Boolean(value) => output.push_str(if *value { "true" } else { "false" }),
        CanonicalValue::Number(value) => {
            if !value.is_finite() {
                return Err(PersistenceCompatError::NonFiniteNumber);
            }
            output.push_str(ryu_js::Buffer::new().format_finite(*value));
        }
        CanonicalValue::String(value) => output.push_str(
            &serde_json::to_string(value).map_err(|_| PersistenceCompatError::JsonEncoding)?,
        ),
        CanonicalValue::Array(values) => {
            output.push('[');
            for (index, value) in values.iter().enumerate() {
                if index != 0 {
                    output.push(',');
                }
                write_canonical_value(value, output)?;
            }
            output.push(']');
        }
        CanonicalValue::Object(values) => {
            output.push('{');
            let mut entries = values
                .iter()
                .filter(|(key, value)| {
                    // The TypeScript Oracle builds a plain object. Assigning this
                    // legacy key invokes Object.prototype instead of creating an
                    // enumerable property, so historical fingerprints omit it.
                    key.as_str() != "__proto__" && !matches!(value, CanonicalValue::Undefined)
                })
                .collect::<Vec<_>>();
            entries.sort_by(|(left, _), (right, _)| compare_javascript_object_keys(left, right));
            for (index, (key, value)) in entries.into_iter().enumerate() {
                if index != 0 {
                    output.push(',');
                }
                output.push_str(
                    &serde_json::to_string(key)
                        .map_err(|_| PersistenceCompatError::JsonEncoding)?,
                );
                output.push(':');
                write_canonical_value(value, output)?;
            }
            output.push('}');
        }
    }
    Ok(())
}

fn compare_javascript_object_keys(left: &str, right: &str) -> std::cmp::Ordering {
    match (javascript_array_index(left), javascript_array_index(right)) {
        (Some(left), Some(right)) => left.cmp(&right),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => left.encode_utf16().cmp(right.encode_utf16()),
    }
}

fn javascript_array_index(value: &str) -> Option<u32> {
    if value.is_empty() || (value.len() > 1 && value.starts_with('0')) {
        return None;
    }
    if !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let parsed = value.parse::<u32>().ok()?;
    (parsed != u32::MAX && parsed.to_string() == value).then_some(parsed)
}

pub fn stable_message_key(
    channel: &str,
    account_key: &str,
    provider_message_id: &str,
) -> Result<String, PersistenceCompatError> {
    required_text(channel, "channel")?;
    if !matches!(channel, "wechat_kf" | "weixin_ilink") {
        return Err(PersistenceCompatError::UnsupportedChannel(
            channel.to_owned(),
        ));
    }
    required_text(account_key, "accountKey")?;
    required_text(provider_message_id, "providerMessageId")?;
    Ok(format!(
        "im_{}",
        &sha256_hex(format!("{channel}\0{account_key}\0{provider_message_id}").as_bytes())
            [..MESSAGE_KEY_HEX_LENGTH]
    ))
}

pub fn stable_client_message_id(
    message_key: &str,
    send_index: u32,
) -> Result<String, PersistenceCompatError> {
    stable_send_key("wb_", message_key, send_index)
}

pub fn stable_attempt_key(
    message_key: &str,
    send_index: u32,
) -> Result<String, PersistenceCompatError> {
    stable_send_key("sa_", message_key, send_index)
}

fn stable_send_key(
    prefix: &str,
    message_key: &str,
    send_index: u32,
) -> Result<String, PersistenceCompatError> {
    required_text(message_key, "messageKey")?;
    Ok(format!(
        "{prefix}{}",
        &sha256_hex(format!("{message_key}\0{send_index}").as_bytes())[..SEND_KEY_HEX_LENGTH]
    ))
}

fn required_text(value: &str, name: &'static str) -> Result<(), PersistenceCompatError> {
    if value.is_empty() {
        return Err(PersistenceCompatError::MissingText(name));
    }
    Ok(())
}

fn sha256_hex(value: &[u8]) -> String {
    let digest = Sha256::digest(value);
    let mut output = String::with_capacity(digest.len() * 2);
    for byte in digest {
        write!(&mut output, "{byte:02x}").expect("writing to a String cannot fail");
    }
    output
}
