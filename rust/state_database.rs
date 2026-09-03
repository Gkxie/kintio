use std::ffi::OsString;
use std::fmt;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::Duration;

use rusqlite::ffi::ErrorCode;
use rusqlite::{Connection, OpenFlags, TransactionBehavior};

use crate::setup::absolute_path;

pub const CURRENT_SCHEMA_VERSION: i64 = 24;
const BUSY_TIMEOUT: Duration = Duration::from_millis(5_000);
const SCHEMA_V24: &str = include_str!("state_schema_v24.sql");

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum JournalMode {
    #[default]
    Wal,
    Delete,
}

impl JournalMode {
    const fn pragma(self) -> &'static str {
        match self {
            Self::Wal => "PRAGMA journal_mode = WAL;",
            Self::Delete => "PRAGMA journal_mode = DELETE;",
        }
    }
}

#[derive(Debug)]
pub enum StateDatabaseError {
    MissingFilePath,
    Closed,
    MigrationRequired(i64),
    NewerSchema(i64),
    UnsupportedSchema(i64),
    FileSystem {
        action: &'static str,
        path: PathBuf,
        source: io::Error,
    },
    Sqlite {
        action: &'static str,
        source: rusqlite::Error,
    },
    InitializationAndRollback {
        initialization: Box<Self>,
        rollback: rusqlite::Error,
    },
    InitializationAndCleanup {
        initialization: Box<Self>,
        cleanup: rusqlite::Error,
    },
    HardeningAndClose {
        hardening: Box<Self>,
        close: rusqlite::Error,
    },
}

impl fmt::Display for StateDatabaseError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::MissingFilePath => formatter.write_str("SQLite filePath is required"),
            Self::Closed => formatter.write_str("State database is closed"),
            Self::MigrationRequired(version) => write!(
                formatter,
                "SQLite schema version {version} requires the native migration slice"
            ),
            Self::NewerSchema(version) => write!(
                formatter,
                "SQLite schema version {version} is newer than supported version {CURRENT_SCHEMA_VERSION}"
            ),
            Self::UnsupportedSchema(version) => write!(
                formatter,
                "SQLite schema version {version} is no longer supported; migrate to version 11 through 23 first"
            ),
            Self::FileSystem {
                action,
                path,
                source,
            } => write!(formatter, "{action} {}: {source}", path.display()),
            Self::Sqlite { action, source } => write!(formatter, "{action}: {source}"),
            Self::InitializationAndRollback { .. } => {
                formatter.write_str("SQLite schema initialization and rollback both failed")
            }
            Self::InitializationAndCleanup { .. } => {
                formatter.write_str("SQLite initialization and cleanup both failed")
            }
            Self::HardeningAndClose { .. } => {
                formatter.write_str("SQLite file hardening and close both failed")
            }
        }
    }
}

impl std::error::Error for StateDatabaseError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::FileSystem { source, .. } => Some(source),
            Self::Sqlite { source, .. } => Some(source),
            Self::InitializationAndRollback { initialization, .. }
            | Self::InitializationAndCleanup { initialization, .. } => Some(initialization),
            Self::HardeningAndClose { hardening, .. } => Some(hardening),
            Self::MissingFilePath
            | Self::Closed
            | Self::MigrationRequired(_)
            | Self::NewerSchema(_)
            | Self::UnsupportedSchema(_) => None,
        }
    }
}

pub struct StateDatabase {
    file_path: PathBuf,
    connection: Option<Connection>,
}

impl Drop for StateDatabase {
    fn drop(&mut self) {
        if self.connection.is_some() {
            let _ = secure_sqlite_files(&self.file_path);
        }
    }
}

impl StateDatabase {
    pub fn open(
        file_path: impl AsRef<Path>,
        journal_mode: JournalMode,
    ) -> Result<Self, StateDatabaseError> {
        let requested = file_path.as_ref();
        if requested.as_os_str().is_empty() {
            return Err(StateDatabaseError::MissingFilePath);
        }
        let cwd = std::env::current_dir().map_err(|source| StateDatabaseError::FileSystem {
            action: "Unable to read current directory for SQLite path",
            path: PathBuf::from("."),
            source,
        })?;
        let file_path = absolute_path(&cwd, requested);
        let parent = file_path
            .parent()
            .ok_or_else(|| StateDatabaseError::FileSystem {
                action: "SQLite path has no parent directory",
                path: file_path.clone(),
                source: io::Error::new(io::ErrorKind::InvalidInput, "missing parent"),
            })?;
        ensure_state_directory(parent)?;

        let flags = OpenFlags::SQLITE_OPEN_READ_WRITE
            | OpenFlags::SQLITE_OPEN_CREATE
            | OpenFlags::SQLITE_OPEN_NO_MUTEX
            | OpenFlags::SQLITE_OPEN_EXRESCODE;
        let mut connection = Connection::open_with_flags(&file_path, flags)
            .map_err(|source| sqlite_error("Unable to open SQLite database", source))?;

        let initialization = initialize(&mut connection, &file_path, journal_mode);
        if let Err(initialization) = initialization {
            return match connection.close() {
                Ok(()) => Err(initialization),
                Err((_connection, cleanup)) => Err(StateDatabaseError::InitializationAndCleanup {
                    initialization: Box::new(initialization),
                    cleanup,
                }),
            };
        }

        Ok(Self {
            file_path,
            connection: Some(connection),
        })
    }

    #[must_use]
    pub fn file_path(&self) -> &Path {
        &self.file_path
    }

    #[must_use]
    pub fn is_closed(&self) -> bool {
        self.connection.is_none()
    }

    pub fn close(&mut self) -> Result<(), StateDatabaseError> {
        self.close_with(Connection::close)
    }

    pub(crate) fn close_with(
        &mut self,
        close_connection: impl FnOnce(Connection) -> Result<(), (Connection, rusqlite::Error)>,
    ) -> Result<(), StateDatabaseError> {
        let Some(connection) = self.connection.take() else {
            return Ok(());
        };
        let hardening = secure_sqlite_files(&self.file_path);
        match close_connection(connection) {
            Ok(()) => hardening,
            Err((connection, close)) => {
                self.connection = Some(connection);
                match hardening {
                    Ok(()) => Err(sqlite_error("Unable to close SQLite database", close)),
                    Err(hardening) => Err(StateDatabaseError::HardeningAndClose {
                        hardening: Box::new(hardening),
                        close,
                    }),
                }
            }
        }
    }

    pub fn has_active_writer(file_path: impl AsRef<Path>) -> Result<bool, StateDatabaseError> {
        let file_path = file_path.as_ref();
        match fs::metadata(file_path) {
            Ok(_) => {}
            Err(source) if source.kind() == io::ErrorKind::NotFound => return Ok(false),
            Err(source) => {
                return Err(StateDatabaseError::FileSystem {
                    action: "Unable to inspect SQLite database",
                    path: file_path.to_path_buf(),
                    source,
                });
            }
        }

        let flags = OpenFlags::SQLITE_OPEN_READ_WRITE
            | OpenFlags::SQLITE_OPEN_NO_MUTEX
            | OpenFlags::SQLITE_OPEN_EXRESCODE;
        let connection = match Connection::open_with_flags(file_path, flags) {
            Ok(connection) => connection,
            Err(source) if is_busy_or_locked(&source) => return Ok(true),
            Err(source) => {
                return Err(sqlite_error("Unable to open SQLite writer probe", source));
            }
        };
        let probe = (|| -> rusqlite::Result<()> {
            connection.busy_timeout(Duration::ZERO)?;
            connection.execute_batch("BEGIN IMMEDIATE")?;
            connection.execute_batch("ROLLBACK")
        })();
        let result = match probe {
            Ok(()) => Ok(false),
            Err(source) if is_busy_or_locked(&source) => Ok(true),
            Err(source) => Err(sqlite_error(
                "Unable to execute SQLite writer probe",
                source,
            )),
        };
        match connection.close() {
            Ok(()) => result,
            Err((_connection, source)) => {
                Err(sqlite_error("Unable to close SQLite writer probe", source))
            }
        }
    }

    #[cfg(test)]
    pub(crate) fn connection(&self) -> Result<&Connection, StateDatabaseError> {
        self.connection.as_ref().ok_or(StateDatabaseError::Closed)
    }
}

fn initialize(
    connection: &mut Connection,
    file_path: &Path,
    journal_mode: JournalMode,
) -> Result<(), StateDatabaseError> {
    secure_sqlite_files(file_path)?;
    connection
        .busy_timeout(BUSY_TIMEOUT)
        .map_err(|source| sqlite_error("Unable to set SQLite busy timeout", source))?;
    connection
        .execute_batch(journal_mode.pragma())
        .map_err(|source| sqlite_error("Unable to set SQLite journal mode", source))?;
    connection
        .execute_batch("PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;")
        .map_err(|source| sqlite_error("Unable to configure SQLite durability", source))?;

    let version = connection
        .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
        .map_err(|source| sqlite_error("Unable to read SQLite schema version", source))?;
    match version {
        CURRENT_SCHEMA_VERSION => {}
        0 => create_fresh_schema(connection)?,
        11..=23 => return Err(StateDatabaseError::MigrationRequired(version)),
        value if value > CURRENT_SCHEMA_VERSION => {
            return Err(StateDatabaseError::NewerSchema(value));
        }
        value => return Err(StateDatabaseError::UnsupportedSchema(value)),
    }
    secure_sqlite_files(file_path)
}

fn create_fresh_schema(connection: &mut Connection) -> Result<(), StateDatabaseError> {
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|source| sqlite_error("Unable to begin SQLite schema transaction", source))?;
    let initialization = transaction
        .execute_batch(SCHEMA_V24)
        .and_then(|()| transaction.pragma_update(None, "user_version", CURRENT_SCHEMA_VERSION));
    if let Err(source) = initialization {
        let initialization = sqlite_error("Unable to create SQLite schema version 24", source);
        return match transaction.rollback() {
            Ok(()) => Err(initialization),
            Err(rollback) => Err(StateDatabaseError::InitializationAndRollback {
                initialization: Box::new(initialization),
                rollback,
            }),
        };
    }
    transaction
        .commit()
        .map_err(|source| sqlite_error("Unable to commit SQLite schema version 24", source))
}

fn ensure_state_directory(path: &Path) -> Result<(), StateDatabaseError> {
    match fs::symlink_metadata(path) {
        Ok(_) => {}
        Err(source) if source.kind() == io::ErrorKind::NotFound => {
            let mut builder = fs::DirBuilder::new();
            builder.recursive(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::DirBuilderExt;
                builder.mode(0o700);
            }
            builder
                .create(path)
                .map_err(|source| StateDatabaseError::FileSystem {
                    action: "Unable to create SQLite directory",
                    path: path.to_path_buf(),
                    source,
                })?;
        }
        Err(source) => {
            return Err(StateDatabaseError::FileSystem {
                action: "Unable to inspect SQLite directory",
                path: path.to_path_buf(),
                source,
            });
        }
    }
    let metadata = fs::symlink_metadata(path).map_err(|source| StateDatabaseError::FileSystem {
        action: "Unable to verify SQLite directory",
        path: path.to_path_buf(),
        source,
    })?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(StateDatabaseError::FileSystem {
            action: "SQLite parent is not a regular directory",
            path: path.to_path_buf(),
            source: io::Error::new(io::ErrorKind::InvalidInput, "invalid directory"),
        });
    }
    Ok(())
}

fn secure_sqlite_files(file_path: &Path) -> Result<(), StateDatabaseError> {
    for candidate in [
        file_path.to_path_buf(),
        append_path_suffix(file_path, "-wal"),
        append_path_suffix(file_path, "-shm"),
    ] {
        let metadata = match fs::metadata(&candidate) {
            Ok(metadata) => metadata,
            Err(source) if source.kind() == io::ErrorKind::NotFound => continue,
            Err(source) => {
                return Err(StateDatabaseError::FileSystem {
                    action: "Unable to inspect SQLite file",
                    path: candidate,
                    source,
                });
            }
        };
        let mut permissions = metadata.permissions();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            permissions.set_mode(0o600);
        }
        #[cfg(windows)]
        permissions.set_readonly(false);
        match fs::set_permissions(&candidate, permissions) {
            Ok(()) => {}
            Err(source) if source.kind() == io::ErrorKind::NotFound => continue,
            Err(source) => {
                return Err(StateDatabaseError::FileSystem {
                    action: "Unable to secure SQLite file",
                    path: candidate,
                    source,
                });
            }
        }
    }
    Ok(())
}

fn append_path_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut value = OsString::from(path.as_os_str());
    value.push(suffix);
    PathBuf::from(value)
}

fn sqlite_error(action: &'static str, source: rusqlite::Error) -> StateDatabaseError {
    StateDatabaseError::Sqlite { action, source }
}

fn is_busy_or_locked(error: &rusqlite::Error) -> bool {
    matches!(
        error.sqlite_error_code(),
        Some(ErrorCode::DatabaseBusy | ErrorCode::DatabaseLocked)
    )
}
