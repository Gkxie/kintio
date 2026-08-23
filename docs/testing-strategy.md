# 测试工程方案

## 原则

- 保留原生 `node:test`，不引入 Jest、ORM 或测试 DSL。
- 测试按真实边界分层，不按源文件一比一复制。
- 组件测试使用真实临时 SQLite，不再维护手写 MemoryStateStore。
- 时序测试使用 Promise barrier，不使用固定 sleep 猜竞态。
- 默认测试必须 0 skip；所有真实外部测试移出默认发现路径。
- 模型测试断言工具、字段和语义，不断言完整自然语言句子。

## 目录

```text
test/
├── support/
│   ├── wecom-message.js
│   ├── temp-sqlite.js
│   ├── fake-wecom-server.js
│   ├── fake-codex-process.js
│   └── barriers.js
├── fixtures/
│   ├── wecom/
│   ├── codex/
│   └── migration/
├── unit/
├── integration/
├── recovery/
├── security/
└── opt-in/
    ├── real-codex.integration.js
    └── live-wecom.integration.js
```

`opt-in` 文件不使用 `.test.js` 后缀，避免被默认 `node --test` 发现。

## 分层

### Unit

无文件、SQLite、网络或子进程：

- 消息分类、摘要、merged recursion。
- 授权状态转移。
- send contract、UTF-8、批次额度。
- steering 边界选择。
- fingerprint 与稳定 msgid。
- 图片魔数、大小、安全路径。
- SOP 静态检查：禁止具体测试人物/属性进入通用规则；语义泛化放到 real Codex eval。

### SQLite 与协议行为

使用真实临时 SQLite 或官方协议 fixture：

- SQLite schema、PRAGMA、迁移、状态机和事务。
- 微信 API 请求体与错误码。
- 回调加解密与畸形输入。
- Codex JSONL：退出、超时、乱序、多 steer、关闭竞态。
- staging MCP：schema、单条字段校验、无 Secret/目标/HTTP/DB；最终预算由宿主检查。

这些测试直接调用具体 SqliteStore 和协议实现，不要求创建 repository interface。

### Integration

真实 SQLite 与生产编排，仅 mock 外部边界：

- Hono callback → sync → inbox。
- inbox → 授权/人工门禁 → fake Codex。
- Codex transcript → steering filter → outbox。
- outbox → fake 微信 HTTP → receipt。
- 图片下载、临时输入、生成结果、上传、发送、清理。
- 生成图 durable spool 在 outbox 前后 SIGKILL 可恢复，且最终无孤儿文件。
- `msg_send_fail` 更新 accepted 回执。
- active turn 完成时若会话已人工接管或暂停，final batch 必须 suppressed 且 outbox 为空。
- 人工期间 API 实际返回的消息在恢复后只作为一次 context handoff 消费。

### Recovery

通过子进程 SIGKILL 验证真实崩溃：

- 页面事务提交前后。
- Codex start/steer 前后。
- final batch 写入前后。
- sending 与微信返回之间。
- accepted 与主消息 completed 之间。
- 批次部分成功。
- SQLite busy、只读和损坏。

不在业务逻辑增加测试专用分支。允许在现有 transport/clock 依赖边界注入 fake，或由父进程
轮询 SQLite 的可观察线性化状态后 SIGKILL；每个崩溃用例必须写明命中的持久化状态。

### Security

- 未授权所有消息类型：0 Codex、0 下载、0 回复。
- root wildcard 拒绝。
- 跨客户 thread/media 隔离。
- Secret canary 不进入 prompt、日志或工具环境。
- shell、本地文件、私网网络禁止；托管 web search 仍可用。
- generated path 必须位于配置的受信目录，不能只按路径片段删除。
- 媒体下载流式限制大小。
- SQLite 参数化与恶意 ID。

### Real Codex / Fake WeChat

手动或 nightly：

- 使用真实 Codex app-server 和 staging MCP。
- 微信 API 指向本地 fake server。
- 验证原生工具选择、steering、五条额度和目标绑定。
- 不断言完整文案。
- 至少三个互不相关的图片编辑意图验证 delta/preservation 语义；这是模型 eval，不冒充纯单元测试。
- hosted web search 可用且私网/本机不可达的行为探针只在这里运行；默认安全测试只验证启动配置。

### Upstream-only Mock / Real Downstream

这是唯一允许真实微信发送的测试：

```text
mock sync_msg
→ real SQLite
→ real Codex
→ real 微信素材下载/上传
→ real kf/send_msg
```

硬性安全条件：

- 必须显式设置 `LIVE_WECOM_OPEN_KFID`。
- 必须显式设置 `LIVE_WECOM_EXTERNAL_USER_ID`。
- 必须设置 `LIVE_WECOM_ACK=SEND_REAL_MESSAGE`。
- 必须显式设置单一 `LIVE_SCENARIO` 和输入 fixture/media ID；禁止从生产 DB 选目标或图片。
- 一次命令只允许一个场景，`--test-concurrency=1`。
- 运行前打印目标和预计发送数；预计 >5 直接退出。
- 目标必须同时存在于独立 live allowlist，并打印预计消息类型。
- 自动 live 只有 `accepted` 通过；`uncertain` 必须失败并人工核实。异步 `msg_send_fail`
  和客户端显示不由 mock-upstream 测试证明，放入独立部署 smoke/人工记录。
- 禁止从生产 DB 自动选择客户。
- Secret 只从受保护环境注入，不出现在命令行、测试名称或日志。
- 运行结束打印实际 `send_msg` 次数和 `N/5`；客户端显示仍由失败事件观察窗或人工截图确认。

## SQLite 契约矩阵

- 空库创建与重复启动。
- 未知更高 schema 版本拒绝。
- `journal_mode=WAL`、`foreign_keys=ON`、`integrity_check=ok`。
- DB 权限 0600。
- legacy JSON/journal 一次导入，重复导入幂等。
- 同步页面与 cursor 原子提交。
- 重复 callback/msgid/乱序页面幂等。
- 两个 open_kfid 使用相同 msgid 时，message_key、primary 归组、outbox 和 spool 完全隔离。
- 授权计数并发正确。
- pending 消息稳定排序。
- final batch/outbox 原子提交。
- attempt key 相同、fingerprint 不同立即失败。
- accepted/failed/uncertain 状态转换不可逆。
- accepted 只表示 API 接受，不能断言客户端送达；uncertain 不能作为自动成功。
- TTL 使用注入时钟。
- 两连接竞争与事务回滚。

## 并发与 steering 矩阵

- 同客户 2、3、5、10 条快速消息。
- text/image/link 混合 steer。
- 工具调用位于 steer RPC 和 UserMessage 事件的各个边界。
- 多个 UserMessage 乱序。
- follow-up 在 completed 前后到达。
- 客户 A 慢 turn 不阻塞 B。
- 同用户不同 open_kfid 隔离。
- 两 callback 返回同页只产生一个 inbox 工作单。
- shutdown 停止接单、drain、再关闭 Codex/DB。
- steering 前淘汰的 staged 候选不占最终五条额度；最终批次超限只允许一次模型缩减重试。
- 单实例锁：第二进程失败、存活锁不可抢、SIGKILL 后 stale lock 可回收、恢复后 integrity_check 通过。

## npm scripts

```json
{
  "test": "npm run test:deterministic",
  "test:unit": "node --test test/unit/*.test.js",
  "test:integration": "node --test test/integration/*.test.js",
  "test:recovery": "node --test --test-concurrency=1 test/recovery/*.test.js",
  "test:security": "node --test test/security/*.test.js",
  "test:deterministic": "node scripts/check-test-markers.js && node --test test/unit/*.test.js test/integration/*.test.js test/recovery/*.test.js test/security/*.test.js",
  "test:coverage": "node --test --experimental-test-coverage --test-coverage-lines=90 --test-coverage-branches=80 --test-coverage-functions=90 test/unit/*.test.js test/integration/*.test.js test/recovery/*.test.js test/security/*.test.js",
  "test:agent": "node --test --test-concurrency=1 test/opt-in/real-codex.integration.js",
  "test:live": "node --test --test-concurrency=1 test/opt-in/live-wecom.integration.js"
}
```

## CI 门禁

PR：

1. `npm ci`
2. Node 22 与 Node 24 矩阵
3. deterministic：0 fail、0 skip；静态脚本拒绝 skip/todo/only
4. 行 ≥90%、分支 ≥80%、函数 ≥90%
5. migration、integrity_check、foreign_key_check
6. `npm audit --omit=dev --audit-level=high`
7. 确认 opt-in/live 未被默认发现
8. 不允许 flaky retry

Nightly 运行 real Codex＋fake WeChat。真实微信只在受保护的手动环境运行。

## 验收追踪

实现阶段维护 `test/acceptance-map.json`，每个非 manual ID 必须记录：实施 Phase、验收类型、
测试文件、测试名称和运行命令。Phase 5 生成 `ID → test → command → result` 报告；manual 项
单独记录运维证据，不伪装成自动测试。图片像素质量、来源可信度和 Agent 是否遵循策略属于
real Codex eval 或人工验收，不能标成 deterministic covered。

Agent eval 固定场景、重复次数和零容忍安全断言，不以随机自然语言相似度打分；视觉观感与
客户端实际显示只记录人工证据，不阻塞 deterministic CI，但属于 release 前验收。

## 禁止的测试模式

- 手写大段 MemoryStore 代替生产 SQLite。
- 断言模型完整句子。
- prompt 全量 snapshot。
- 使用固定 sleep 通过竞态。
- 一个环境变量触发多个真实发送场景。
- 自动选择生产客户。
- 把 uncertain 当成功。
- 为测试方便增加生产专用分支或抽象。
