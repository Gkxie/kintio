use std::fs;
use std::path::Path;

use rusqlite::ffi::ErrorCode;
use rusqlite::{Connection, OpenFlags};
use serde::Deserialize;
use tempfile::TempDir;

use crate::state_database::{
    CURRENT_SCHEMA_VERSION, JournalMode, StateDatabase, StateDatabaseError,
};

const SCHEMA_FIXTURE: &str = include_str!("../test/fixtures/state-schema-v24.json");

#[derive(Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
struct SchemaFixture {
    user_version: i64,
    has_sqlite_sequence: bool,
    auto_index_count: i64,
    entries: Vec<SchemaEntry>,
}

#[derive(Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
struct SchemaEntry {
    r#type: String,
    name: String,
    tbl_name: String,
    sql: String,
}

fn fixture() -> SchemaFixture {
    serde_json::from_str(SCHEMA_FIXTURE).unwrap()
}

fn snapshot(connection: &Connection) -> SchemaFixture {
    let mut statement = connection
        .prepare(
            "SELECT type, name, tbl_name, sql FROM sqlite_schema \
             WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL \
             ORDER BY type, name",
        )
        .unwrap();
    let entries = statement
        .query_map([], |row| {
            Ok(SchemaEntry {
                r#type: row.get(0)?,
                name: row.get(1)?,
                tbl_name: row.get(2)?,
                sql: normalize_sql(&row.get::<_, String>(3)?),
            })
        })
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    SchemaFixture {
        user_version: connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap(),
        has_sqlite_sequence: connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE name = 'sqlite_sequence')",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap()
            == 1,
        auto_index_count: connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_schema WHERE type = 'index' \
                 AND name LIKE 'sqlite_autoindex_%'",
                [],
                |row| row.get(0),
            )
            .unwrap(),
        entries,
    }
}

fn normalize_sql(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn raw_connection(path: &Path) -> Connection {
    Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_WRITE
            | OpenFlags::SQLITE_OPEN_CREATE
            | OpenFlags::SQLITE_OPEN_NO_MUTEX
            | OpenFlags::SQLITE_OPEN_EXRESCODE,
    )
    .unwrap()
}

#[cfg(unix)]
fn sidecar(path: &Path, suffix: &str) -> std::path::PathBuf {
    let mut value = path.as_os_str().to_os_string();
    value.push(suffix);
    std::path::PathBuf::from(value)
}

#[test]
fn fresh_schema_pragmas_permissions_and_close_match_the_contract() {
    for (journal_mode, expected_journal) in
        [(JournalMode::Wal, "wal"), (JournalMode::Delete, "delete")]
    {
        let root = TempDir::new().unwrap();
        let file = root.path().join("含 空格").join("state 数据库.sqlite");
        let mut state = StateDatabase::open(&file, journal_mode).unwrap();
        let connection = state.connection().unwrap();

        assert_eq!(snapshot(connection), fixture());
        assert_eq!(
            connection
                .pragma_query_value(None, "journal_mode", |row| row.get::<_, String>(0))
                .unwrap(),
            expected_journal,
        );
        assert_eq!(
            connection
                .pragma_query_value(None, "synchronous", |row| row.get::<_, i64>(0))
                .unwrap(),
            2,
        );
        assert_eq!(
            connection
                .pragma_query_value(None, "foreign_keys", |row| row.get::<_, i64>(0))
                .unwrap(),
            1,
        );
        assert_eq!(
            connection
                .pragma_query_value(None, "busy_timeout", |row| row.get::<_, i64>(0))
                .unwrap(),
            5_000,
        );
        assert_eq!(
            connection
                .query_row("PRAGMA integrity_check", [], |row| row.get::<_, String>(0))
                .unwrap(),
            "ok",
        );
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap(),
            0,
        );

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            for candidate in [&file, &sidecar(&file, "-wal"), &sidecar(&file, "-shm")] {
                if candidate.exists() {
                    assert_eq!(
                        fs::metadata(candidate).unwrap().permissions().mode() & 0o777,
                        0o600
                    );
                }
            }
        }

        assert!(!state.is_closed());
        state.close().unwrap();
        assert!(state.is_closed());
        state.close().unwrap();
        assert!(matches!(
            state.connection(),
            Err(StateDatabaseError::Closed)
        ));

        let renamed = root.path().join("renamed.sqlite");
        fs::rename(&file, &renamed).unwrap();
        let mut reopened = StateDatabase::open(&renamed, JournalMode::Delete).unwrap();
        assert_eq!(snapshot(reopened.connection().unwrap()), fixture());
        reopened.close().unwrap();
    }
}

#[test]
fn a_failed_physical_close_keeps_the_connection_retryable() {
    let root = TempDir::new().unwrap();
    let file = root.path().join("retry-close.sqlite");
    let mut state = StateDatabase::open(&file, JournalMode::Delete).unwrap();
    let result = state.close_with(|connection| {
        Err((
            connection,
            rusqlite::Error::SqliteFailure(
                rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_BUSY),
                Some("synthetic close failure".to_owned()),
            ),
        ))
    });
    assert!(matches!(result, Err(StateDatabaseError::Sqlite { .. })));
    assert!(!state.is_closed());
    assert!(state.connection().is_ok());

    state.close().unwrap();
    assert!(state.is_closed());
}

#[cfg(unix)]
#[test]
fn an_existing_shared_directory_is_preserved_while_database_files_are_private() {
    use std::os::unix::fs::PermissionsExt;

    let root = TempDir::new().unwrap();
    let shared = root.path().join("shared");
    fs::create_dir(&shared).unwrap();
    fs::set_permissions(&shared, fs::Permissions::from_mode(0o777)).unwrap();
    let file = shared.join("state.sqlite");

    let mut state = StateDatabase::open(&file, JournalMode::Wal).unwrap();
    assert_eq!(
        fs::metadata(&shared).unwrap().permissions().mode() & 0o777,
        0o777
    );
    assert_eq!(
        fs::metadata(&file).unwrap().permissions().mode() & 0o777,
        0o600
    );
    state.close().unwrap();
}

#[test]
fn version_classification_and_failed_fresh_creation_release_the_handle() {
    let root = TempDir::new().unwrap();
    for version in [11, 17, 23] {
        let file = root.path().join(format!("migration-{version}.sqlite"));
        let connection = raw_connection(&file);
        connection
            .pragma_update(None, "user_version", version)
            .unwrap();
        connection.close().unwrap();
        assert!(matches!(
            StateDatabase::open(&file, JournalMode::Delete).err().unwrap(),
            StateDatabaseError::MigrationRequired(found) if found == version
        ));
    }
    for version in [-1, 1, 10] {
        let file = root.path().join(format!("unsupported-{version}.sqlite"));
        let connection = raw_connection(&file);
        connection
            .pragma_update(None, "user_version", version)
            .unwrap();
        connection.close().unwrap();
        assert!(matches!(
            StateDatabase::open(&file, JournalMode::Delete).err().unwrap(),
            StateDatabaseError::UnsupportedSchema(found) if found == version
        ));
    }
    let future = root.path().join("future.sqlite");
    let connection = raw_connection(&future);
    connection
        .pragma_update(None, "user_version", CURRENT_SCHEMA_VERSION + 1)
        .unwrap();
    connection.close().unwrap();
    assert!(matches!(
        StateDatabase::open(&future, JournalMode::Delete)
            .err()
            .unwrap(),
        StateDatabaseError::NewerSchema(25)
    ));

    let conflict = root.path().join("conflicting-fresh.sqlite");
    let connection = raw_connection(&conflict);
    connection
        .execute_batch("CREATE TABLE agent_sessions (sentinel TEXT) STRICT;")
        .unwrap();
    connection.close().unwrap();
    assert!(matches!(
        StateDatabase::open(&conflict, JournalMode::Delete)
            .err()
            .unwrap(),
        StateDatabaseError::Sqlite { .. }
    ));
    let connection = raw_connection(&conflict);
    assert_eq!(
        connection
            .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
            .unwrap(),
        0,
    );
    assert_eq!(
        connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
        1,
    );
    connection.close().unwrap();
    fs::rename(&conflict, root.path().join("released.sqlite")).unwrap();
}

#[test]
fn writer_probe_distinguishes_missing_busy_readable_and_corrupt_files() {
    let root = TempDir::new().unwrap();
    let missing = root.path().join("missing.sqlite");
    assert!(!StateDatabase::has_active_writer(&missing).unwrap());
    assert!(!missing.exists());

    let file = root.path().join("writer.sqlite");
    let mut state = StateDatabase::open(&file, JournalMode::Delete).unwrap();
    state.close().unwrap();
    let connection = raw_connection(&file);
    connection.execute_batch("BEGIN IMMEDIATE").unwrap();
    assert!(StateDatabase::has_active_writer(&file).unwrap());
    connection.execute_batch("ROLLBACK").unwrap();
    assert!(!StateDatabase::has_active_writer(&file).unwrap());

    connection
        .execute_batch("BEGIN; SELECT * FROM conversations;")
        .unwrap();
    assert!(!StateDatabase::has_active_writer(&file).unwrap());
    connection.execute_batch("ROLLBACK").unwrap();
    connection.close().unwrap();

    let corrupt = root.path().join("corrupt.sqlite");
    fs::write(&corrupt, b"not a sqlite database").unwrap();
    assert!(StateDatabase::has_active_writer(&corrupt).is_err());
}

#[test]
fn database_constraints_reject_invalid_state() {
    let root = TempDir::new().unwrap();
    let file = root.path().join("constraints.sqlite");
    let state = StateDatabase::open(&file, JournalMode::Delete).unwrap();
    let connection = state.connection().unwrap();

    assert_constraint(connection.execute(
        "INSERT INTO conversations (channel, open_kfid, external_userid, updated_at) \
         VALUES ('invalid', 'account', 'peer', 1)",
        [],
    ));
    assert_constraint(connection.execute(
        "INSERT INTO authorizations (external_userid, authorized, updated_at) \
         VALUES ('peer', 2, 1)",
        [],
    ));
    connection
        .execute(
            "INSERT INTO inbound_messages (message_key, open_kfid, msgid, external_userid, \
         channel, origin, msg_type, status, created_at, updated_at) \
         VALUES ('message', 'account', 'provider', 'peer', 'wechat_kf', 'customer', 'text', \
         'received', 1, 1)",
            [],
        )
        .unwrap();
    connection.execute(
        "INSERT INTO ilink_accounts (account_key, provider_account_id, owner_peer_id, base_url, \
         created_at, updated_at) VALUES ('ia_account', 'provider-account', 'owner', 'https://example.test', 1, 1)",
        [],
    ).unwrap();
    assert_constraint(connection.execute(
        "INSERT INTO ilink_reply_windows (account_key, peer_id, account_generation, \
         source_message_key, source_inbox_seq, issued_at, expires_at, secret_generation, \
         created_at, updated_at) VALUES \
         ('ia_account', 'peer', 1, 'message', 1, 1, 2, 0, 1, 1)",
        [],
    ));
    assert_constraint(connection.execute(
        "INSERT INTO agent_sessions (token_hash, source_message_key, open_kfid, external_userid, \
         channel, reply_window_id, boundary_inbox_seq, expires_at, created_at, updated_at) \
         VALUES ('token', 'message', 'account', 'peer', 'wechat_kf', 1, 1, 2, 1, 1)",
        [],
    ));
}

fn assert_constraint(result: rusqlite::Result<usize>) {
    assert!(
        result
            .as_ref()
            .err()
            .and_then(rusqlite::Error::sqlite_error_code)
            == Some(ErrorCode::ConstraintViolation),
        "database accepted invalid state or returned a non-constraint error",
    );
}
