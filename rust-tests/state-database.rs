use std::fs::File;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

use kintio_native::{JournalMode, StateDatabase};
use rusqlite::{Connection, OpenFlags};
use serde_json::{Value, json};
use tempfile::{TempDir, tempfile};
use wait_timeout::ChildExt;

const SCHEMA_FIXTURE: &str = include_str!("../test/fixtures/state-schema-v24.json");

const NODE_STATE_ORACLE: &str = r#"
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const source = await new Promise((resolve, reject) => {
  let value = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { value += chunk; });
  process.stdin.on('end', () => resolve(value));
  process.stdin.on('error', reject);
});
const input = JSON.parse(source);
const moduleUrl = pathToFileURL(
  path.join(process.cwd(), 'src/state/persistence.ts'),
).href;
const { StatePersistence } = await import(moduleUrl);

if (input.operation === 'probe') {
  process.stdout.write(JSON.stringify({
    active: StatePersistence.hasActiveWriter(input.filePath),
  }));
} else {
  const state = new StatePersistence({
    filePath: input.filePath,
    journalMode: input.journalMode,
  });
  state.close();
  const database = new DatabaseSync(input.filePath, { readOnly: true });
  const entries = database.prepare(`
    SELECT type, name, tbl_name AS tblName, sql
    FROM sqlite_schema
    WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL
    ORDER BY type, name
  `).all().map((entry) => ({
    ...entry,
    sql: String(entry.sql).replace(/\s+/gu, ' ').trim(),
  }));
  const userVersion = Number(
    database.prepare('PRAGMA user_version').get().user_version,
  );
  const hasSqliteSequence = Boolean(database.prepare(
    "SELECT 1 AS found FROM sqlite_schema WHERE name = 'sqlite_sequence'",
  ).get()?.found);
  const autoIndexCount = Number(database.prepare(
    "SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'index' AND name LIKE 'sqlite_autoindex_%'",
  ).get().count);
  database.close();
  process.stdout.write(JSON.stringify({
    userVersion,
    hasSqliteSequence,
    autoIndexCount,
    entries,
  }));
}
"#;

const NODE_LOCK_HOLDER: &str = r#"
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
const iterator = lines[Symbol.asyncIterator]();
const first = await iterator.next();
if (first.done) throw new Error('lock holder received no request');
const input = JSON.parse(first.value);
const database = new DatabaseSync(input.filePath);
database.exec('PRAGMA busy_timeout = 0');
if (input.kind === 'writer') {
  database.exec('BEGIN IMMEDIATE');
} else {
  database.exec('BEGIN');
  database.prepare('SELECT COUNT(*) FROM conversations').get();
}
process.stdout.write('ready\n');
await iterator.next();
database.exec('ROLLBACK');
database.close();
"#;

const PROCESS_TIMEOUT: Duration = Duration::from_secs(10);

struct ChildGuard {
    child: Option<Child>,
}

impl ChildGuard {
    fn new(child: Child) -> Self {
        Self { child: Some(child) }
    }

    fn child_mut(&mut self) -> &mut Child {
        self.child.as_mut().expect("child process is present")
    }

    fn finish(mut self) -> ExitStatus {
        let mut child = self.child.take().expect("child process is present");
        match child.wait_timeout(PROCESS_TIMEOUT) {
            Ok(Some(status)) => status,
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                panic!("Node test process timed out");
            }
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                panic!("Unable to wait for Node test process: {error}");
            }
        }
    }
}

impl Drop for ChildGuard {
    fn drop(&mut self) {
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

fn read_capture(mut file: File) -> Vec<u8> {
    file.seek(SeekFrom::Start(0)).unwrap();
    let mut output = Vec::new();
    file.read_to_end(&mut output).unwrap();
    output
}

fn node_request(input: &Value) -> Value {
    let stdout = tempfile().unwrap();
    let stderr = tempfile().unwrap();
    let child = Command::new("node")
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .args([
            "--disable-warning=ExperimentalWarning",
            "--experimental-strip-types",
            "--input-type=module",
            "--eval",
            NODE_STATE_ORACLE,
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::from(stdout.try_clone().unwrap()))
        .stderr(Stdio::from(stderr.try_clone().unwrap()))
        .spawn()
        .expect("Node state Oracle starts");
    let mut process = ChildGuard::new(child);
    process
        .child_mut()
        .stdin
        .take()
        .expect("Oracle stdin is piped")
        .write_all(&serde_json::to_vec(input).unwrap())
        .unwrap();
    let status = process.finish();
    let stdout = read_capture(stdout);
    let stderr = read_capture(stderr);
    assert!(
        status.success(),
        "Node state Oracle failed: {}",
        String::from_utf8_lossy(&stderr),
    );
    serde_json::from_slice(&stdout).expect("Node state Oracle output is JSON")
}

struct NodeLockHolder {
    process: Option<ChildGuard>,
    stderr: Option<File>,
}

impl NodeLockHolder {
    fn start(file_path: &std::path::Path, kind: &str) -> Self {
        let stderr = tempfile().unwrap();
        let child = Command::new("node")
            .args([
                "--disable-warning=ExperimentalWarning",
                "--input-type=module",
                "--eval",
                NODE_LOCK_HOLDER,
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::from(stderr.try_clone().unwrap()))
            .spawn()
            .expect("Node lock holder starts");
        let mut process = ChildGuard::new(child);
        let request = serde_json::to_vec(&json!({
            "filePath": file_path,
            "kind": kind,
        }))
        .unwrap();
        let stdin = process
            .child_mut()
            .stdin
            .as_mut()
            .expect("lock holder stdin is piped");
        stdin.write_all(&request).unwrap();
        stdin.write_all(b"\n").unwrap();
        stdin.flush().unwrap();

        let stdout = process
            .child_mut()
            .stdout
            .take()
            .expect("lock holder stdout is piped");
        let (sender, receiver) = mpsc::sync_channel(1);
        let reader = thread::spawn(move || {
            let mut ready = String::new();
            let result = BufReader::new(stdout).read_line(&mut ready).map(|_| ready);
            let _ = sender.send(result);
        });
        let ready = match receiver.recv_timeout(Duration::from_secs(10)) {
            Ok(Ok(ready)) => ready,
            received => {
                drop(process);
                let _ = reader.join();
                panic!(
                    "Node lock holder readiness failed ({received:?}): {}",
                    String::from_utf8_lossy(&read_capture(stderr)),
                );
            }
        };
        reader.join().unwrap();
        assert_eq!(ready, "ready\n", "Node lock holder did not become ready");
        Self {
            process: Some(process),
            stderr: Some(stderr),
        }
    }

    fn release(mut self) {
        let mut process = self.process.take().unwrap();
        drop(process.child_mut().stdin.take());
        let status = process.finish();
        let stderr = read_capture(self.stderr.take().unwrap());
        assert!(
            status.success(),
            "Node lock holder failed: {}",
            String::from_utf8_lossy(&stderr),
        );
    }
}

impl Drop for NodeLockHolder {
    fn drop(&mut self) {
        drop(self.process.take());
    }
}

fn raw_connection(path: &std::path::Path) -> Connection {
    Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_WRITE
            | OpenFlags::SQLITE_OPEN_NO_MUTEX
            | OpenFlags::SQLITE_OPEN_EXRESCODE,
    )
    .unwrap()
}

#[test]
fn node_and_rust_open_each_others_v24_files() {
    let expected: Value = serde_json::from_str(SCHEMA_FIXTURE).unwrap();
    for (mode, node_mode) in [(JournalMode::Wal, "WAL"), (JournalMode::Delete, "DELETE")] {
        let root = TempDir::new().unwrap();
        let node_file = root.path().join("Node 含 空格.sqlite");
        let node_snapshot = node_request(&json!({
            "operation": "open",
            "filePath": node_file,
            "journalMode": node_mode,
        }));
        assert_eq!(node_snapshot, expected);
        let mut rust = StateDatabase::open(&node_file, mode).unwrap();
        rust.close().unwrap();

        let rust_file = root.path().join("Rust 含 空格.sqlite");
        let mut rust = StateDatabase::open(&rust_file, mode).unwrap();
        rust.close().unwrap();
        let node_snapshot = node_request(&json!({
            "operation": "open",
            "filePath": rust_file,
            "journalMode": node_mode,
        }));
        assert_eq!(node_snapshot, expected);

        let renamed = root.path().join(format!("closed-{node_mode}.sqlite"));
        std::fs::rename(&rust_file, &renamed).unwrap();
        let mut reopened = StateDatabase::open(&renamed, JournalMode::Delete).unwrap();
        reopened.close().unwrap();
    }
}

#[test]
fn node_and_rust_detect_cross_process_writers_without_blocking_readers() {
    for (mode, journal) in [(JournalMode::Wal, "WAL"), (JournalMode::Delete, "DELETE")] {
        let root = TempDir::new().unwrap();
        let file = root.path().join(format!("locking {journal} 中文.sqlite"));
        let mut state = StateDatabase::open(&file, mode).unwrap();
        state.close().unwrap();

        let holder = NodeLockHolder::start(&file, "writer");
        assert!(StateDatabase::has_active_writer(&file).unwrap());
        holder.release();
        assert!(!StateDatabase::has_active_writer(&file).unwrap());

        let connection = raw_connection(&file);
        connection.execute_batch("BEGIN IMMEDIATE").unwrap();
        assert_eq!(
            node_request(&json!({ "operation": "probe", "filePath": file }))["active"],
            true,
        );
        connection.execute_batch("ROLLBACK").unwrap();

        let holder = NodeLockHolder::start(&file, "reader");
        assert!(!StateDatabase::has_active_writer(&file).unwrap());
        holder.release();

        connection
            .execute_batch("BEGIN; SELECT COUNT(*) FROM conversations;")
            .unwrap();
        assert_eq!(
            node_request(&json!({ "operation": "probe", "filePath": file }))["active"],
            false,
        );
        connection.execute_batch("ROLLBACK").unwrap();
        connection.close().unwrap();
    }
}
