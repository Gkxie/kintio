# 系统架构重构方案

## 目标

- 精简生产路径，删除已不参与运行的兼容分支。
- 用单一 SQLite 取代 JSON 状态与独立发送 journal。
- 把同步、会话处理、Codex 和真实发送的边界变得可事务化、可恢复。
- staging MCP 不接收微信凭据、客户目标、数据库或 HTTP 客户端，只产生纯校验候选。
- 保留现有授权、人工接管、turn/steer、多模态、原生发送和图片生成能力。

## 明确不做

- 不引入 ORM、Redis、队列服务、PostgreSQL、事件总线、CQRS 或 DI 容器。
- 不为每张表创建 repository/interface/DAO/service 四层。
- 不宣称支持多 Node 实例；本次明确为单实例架构。
- 不为测试导出无业务意义的私有函数。

## 目标数据流

```text
加密回调 → 立即 success
→ sync_msg
→ 一页消息与 cursor 同事务写入 SQLite inbox
→ 按会话消费 pending inbox
→ 授权 / 人工 / 暂停门禁
→ Codex turn/start 或 turn/steer
→ 纯 staging MCP 返回候选发送意图
→ 选择最后 steering 边界之后的最终批次
→ 最终批次与消息状态同事务写入 outbox
→ 宿主 DeliveryService 调用微信
→ 回执写回 SQLite
```

## 模块取舍

### 保留并收敛

- Hono app、回调路由、微信 crypto/XML。
- `wecom-api`：唯一微信 HTTP 客户端。
- `codex-app-server`：JSONL 协议边界。
- media gateway、image stager、UTF-8 工具。
- 一个项目级微信回复 Skill。
- runtime 作为 composition root。

### 合并或重写

| 当前 | 目标 |
|---|---|
| `json-state-store` + `sqlite-tool-journal` | 一个具体 `sqlite-store` |
| 842 行 message processor | `wecom-sync` + `conversation-processor` |
| 962 行 responder 的两套模式 | 只支持生产 app-server/MCP 路径的 `codex-agent` |
| adapter + domain message | 一个 `wecom-message`，负责解析与 Codex 投影 |
| MCP 内真实 WecomSendTools | 无凭据、无发送客户端的 staging MCP |
| 宿主散落的发送分支 | 一个 `delivery-service` |

这里的拆分只对应真实运行边界：同步事务、会话/turn、外部发送。不会为单个函数再包类。

### 删除

- `reply-policy.js`
- `map-location-resolver.js`
- structured reply schema 与 legacy `respond()` 路径
- processor 中旧的直接 reply/outbound 分支
- 宝塔遗留 `.htaccess`
- hand-written MemoryStateStore 测试替身

仍需复用的位置、链接和小程序字段校验，保留为一个纯发送 contract，供 staging MCP 与宿主发送共同调用。

## MCP 安全边界

staging MCP 只接收：

- 五种工具 schema；
- 必要的 `media:N` 目录。

它不得接收：

- CorpID 或 Secret；
- open_kfid 或 external_userid；
- 微信 HTTP 客户端；
- SQLite 路径；
- 任意网络权限。

工具成功仅表示“候选发送意图通过校验并暂存”。真实副作用只能在宿主 outbox 提交之后发生。
被 steering 淘汰的候选不消耗微信额度；宿主在最终批次落库前统一预检官方五条上限。
若最终批次超限，Codex 只允许一次缩减批次重试。

## SQLite 设计

数据库：`data/wecom.sqlite`

启动设置：

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = FULL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
```

初始设计使用八张表；表数不是硬指标，禁止为了凑表数把无关状态塞进 JSON 列：

1. `schema_meta`
   - legacy 导入 hash、时间和来源；schema 版本以 `PRAGMA user_version` 为唯一来源。
2. `sync_cursors`
   - `open_kfid` 主键、cursor、更新时间。
3. `conversations`
   - `(open_kfid, external_userid)` 主键；Codex thread、人工模式、单调 automation_epoch、客服 ID、状态时间。
4. `authorizations`
   - external user 主键；authorized、连续暗号数、最后消息、授权时间。授权作用域明确为
     企业内的 external user 全局授权，不随 open_kfid 重复授权。授权前连续计数必须发生在
     同一个 open_kfid；切换客服即重置。撤销对该 external user 全局生效。
5. `inbound_messages`
   - 单调 `inbox_seq` 主键、稳定 `message_key=SHA256(open_kfid + NUL + msgid)` 唯一，且
     `(open_kfid,msgid)` 唯一；会话、origin、类型、sent_at、状态、primary_message_key、
     payload_json、context 状态、codex_turn_id、client_input_id、claimed epoch、
     steering boundary、错误和时间。恢复顺序只使用 inbox_seq，不依赖秒级 sent_at。
   - 微信没有 msgid 的 system/event 使用 `open_kfid + page cursor + page index + payload hash`
     生成稳定内部 ID；不能因为缺少 msgid 而跳过落库后推进 cursor。
6. `inbound_media`
   - 会话、消息、位置、kind、media_id、filename、sent_at、remembered_at；三天 TTL。
7. `send_attempts`
   - `(source_message_key, send_index)` 唯一；来源、类型、exact payload_json、可选 fallback_for_index、
     fingerprint、稳定 client msgid、状态、微信 msgid、错误和时间。
8. `runtime_controls`
   - 单行 paused、单调 automation_epoch 和更新时间；替代无法事务校验的裸暂停文件。

局部 `payload_json` 只保存单条多态消息或发送内容，不再序列化整个系统状态。终态 inbound message 应清空正文 payload，只保留恢复和审计最小字段。

关键索引固定为：pending inbox `(status,open_kfid,external_userid,inbox_seq)`、发送队列
`(status,updated_at)`、微信回执 `wecom_msgid`、媒体 `(open_kfid,external_userid,remembered_at)`
以及 conversation/thread 唯一键；测试用 `EXPLAIN QUERY PLAN` 验证走索引，不用墙钟延迟作 PR 门禁。

## 状态机

```text
inbound_messages:
received → processing → preparing → ready → completed
                   ↘ steered → absorbed
                   ↘ failed
received → ignored / held
processing / ready → suppressed

send_attempts:
pending → sending → accepted
  ↘ failed    ↘ failed
               ↘ uncertain
blocked fallback → pending（仅对应 primary 明确 failed）
```

状态转换由 SQLite 条件更新约束；非法逆向转换必须报 invariant error。

## 事务边界

### 同步页面

一个事务完成：

1. `INSERT ... ON CONFLICT(open_kfid,msgid) DO NOTHING` 写入页面全部标准化消息；
2. 使用 expected cursor 做 CAS 更新该客服 cursor；
3. commit。

其他 NOT NULL、CHECK、外键或解析错误必须回滚整页。每个 open_kfid 仍由进程内队列串行；
CAS 失败同样回滚。cursor 可以先于业务完成推进，因为消息已经进入持久 inbox。

### 授权

一个事务完成重复 msgid 检查、暗号计数、授权与确认 outbox。确认不经过 Codex。

### Codex 完成

一个事务完成：

1. 预检并展开最终批次，确保总发送数 ≤5；
2. 插入所有 `send_attempts(pending)`；
3. primary 改为 ready；
4. steer 消息改为 absorbed。

turn/start 时捕获 conversation 与 runtime 的 automation_epoch。finalize 事务只允许在
`mode=bot` 且两个 epoch 均未变化时写 outbox；否则 primary/steer 改为 suppressed，不创建
outbox。人工期间 API 实际返回的客户与客服消息进入 held/context pending；会话结束后按
inbox_seq 合并成一次只读交接上下文，再原子标记 consumed。微信平台未返回的人工历史不作保证。

### 外部发送

发送前小事务将 pending 改为 sending；事务外调用微信；返回后小事务写 accepted/failed/uncertain。
网络请求期间绝不持有 SQLite 事务。

所有内部 FK、primary/steer 归组、send attempt、稳定 client msgid 和 spool 文件名统一使用
message_key；裸 msgid 只保留为微信字段。同一 attempt key 再次出现时必须比较 fingerprint；
不同内容禁止复用旧回执。

location/link/miniprogram/image 的确定性文字 fallback 在 final batch 落库前作为独立 blocked
attempt 预留 send_index、exact payload、fingerprint 和稳定 client msgid，并用 fallback_for_index
关联 primary。只有 primary 明确 failed 才能原子激活为 pending，uncertain 绝不激活。批次按
最坏情况预检总 API 发送数；没有剩余额度时不创建 fallback，不能发送到一半才发现超过五条。

发送记录保留策略：uncertain 在人工确认前不得自动删除；accepted/failed 的最小审计字段
保留 30 天，正文 payload 可在 7 天后清空；uncertain 无限保留直到人工归档。授权、cursor、
thread 与当前 conversation 状态不按消息 TTL 删除。

outbox 保存微信 API 可直接发送的 exact payload。所有不可见准备步骤先完成：客户图片先
clone、link/miniprogram 先取得 thumbnail media_id、生成图先上传。得到最终 media_id 后才对
exact payload 计算 fingerprint 并写 outbox。准备失败在 outbox 前决定 fallback；恢复阶段不再
重新解释模型意图。

生成图在取得 media_id 前写入 `data/spool` 下按 message_key 命名的 0600 原子临时文件；outbox
持久化后立即删除。SQLite 不保存图片字节；启动时清理没有对应 preparing 消息的孤儿 spool。

## 关闭与恢复

- 收到 SIGTERM 后先停止接收新任务。
- 先关闭 HTTP listener，拒绝 drain 期间的新 callback。
- 在可配置的有限 drain timeout（默认 10 秒）内等待 sync 队列、active turn 和 delivery。
- 然后关闭 Codex 子进程和 SQLite。
- 超时后保留 processing/pending/sending；下次启动恢复，遗留 sending 转 uncertain；进程仍必须释放 8888。
- 重启后从 SQLite 的 received/processing/steered/ready/pending/sending 状态恢复。
- 遗留 sending 一律转 uncertain，禁止盲目重发。
- 恢复 Codex 输入前，以持久 msgid 对照 app-server `clientUserMessageId`，避免同一客户输入
  再次注入 thread；无法确定时允许 Codex 至少一次，但微信 outbox 仍保证最多一次自动提交。
- delivery worker 在真实发送前重新检查人工接管和暂停状态；已进入人工模式的 pending
  机器人回复取消，不得继续发送。

恢复算法使用持久化的 thread_id、codex_turn_id、client_input_id 和 steering boundary 调用
app-server thread history API：已存在的 client input 不重复注入；已完成 turn 重新提取结果；
存在输入但无完成结果时启动 continuation；完全缺失时才按 inbox_seq 重放。正式语义是
“Codex 输入至少一次、微信自动发送至多一次”。

`sending → uncertain` 选择保守的 at-most-once，因此必须明确承认 uncertain 可能实际发送
零次，也可能一次；在没有官方可验证去重保证前绝不自动重试。

## 人工/API 平台边界

本地 `change_type=3` 只解除机器人内部抑制，不承诺微信平台已经把人工接待切回 API 路由。
若微信控制面仍处于人工模式，需要运维人员显式恢复 API 接入；系统不得报告“已自动切回”。

## 网络与本机安全边界

- Codex command network 保持 false，托管 web search 可独立为 live。
- shell、view_image 和非白名单 MCP 禁用。
- staging MCP 不注入网络客户端、Secret、客户 ID、原始 media_id、文件路径或 DB；其代码不包含
  HTTP/微信客户端。项目按可信内部代码运行，不宣称进程具有 OS 级文件或网络隔离，只保证它
  没有真实发送所需的凭据、目标和实现。
- MCP 只看到 `media:N → kind`；宿主 commit 时再从 SQLite 解析真实 media_id。
- 宿主不抓取客户给出的任意 URL；允许的公网解析需覆盖 DNS 私网回落、IPv4-mapped IPv6、重定向和大小限制。

## Legacy 数据迁移

1. 停止服务并确认 8888 无监听。
2. 在临时路径创建新 SQLite schema。
3. 使用 DELETE journal 的临时 DB，一个事务导入 `wecom-state.json` 与旧 `wecom-tool-journal.sqlite`。
4. 运行 `integrity_check`、`foreign_key_check`。
5. 核对 cursor、thread、已授权数、pending 数、媒体数和发送 attempt 数。
6. 执行 checkpoint、关闭所有连接，并确保临时文件位于同一文件系统后原子 rename 为 `data/wecom.sqlite`。
7. 旧 JSON 与 journal 改名为带时间戳备份，不立即删除。
8. `schema_meta` 标记完成，重复启动不得再次导入。

迁移失败时临时 DB 删除，原文件不修改。

Legacy 映射固定如下：

- `sent → completed`、`ignored → ignored`、`absorbed → absorbed`、`failed → failed`；
- `processing → processing`、`steered → steered`；
- `generated → ready`，并把 outbound/tool/receipt 展开为 send_attempts；
- `authorization_pending` 转为 ready 的授权确认 attempt；
- responseChunks、outboundMessages、toolDispatches、sendReceipts 都必须有明确导入或拒绝原因；
- conversation 的旧拼接 key 只按第一个冒号拆分；
- 旧 journal attempt key 从末尾 send index 反向解析，无法解析的记录保留为 legacy source 并阻止自动重发；
- `WECOM_DB_FILE` 成为新配置；旧 `WECOM_STATE_FILE` 仅用于一次迁移来源并输出弃用警告。
- `WECOM_BOT_PAUSE_FILE` 迁移为 SQLite runtime control；提供一个直接更新该行的最小 pause/resume
  命令，不引入管理服务或额外 API。

## 单实例约束

启动时使用 `data/wecom.lock` 的原子独占创建和 PID 校验；第二实例明确失败。异常遗留锁只有在
PID 不存在且 SQLite 无活动 owner 时才回收。该锁只防误启动，不宣称支持分布式协调。

## 实施阶段

### Phase 0：安全基线

- 确认 `.env`、`data/`、`node_modules/` 被忽略。
- 记录当前确定性测试和覆盖率。
- 在 master 创建不含秘密与运行数据的 baseline commit，并打 `pre-sqlite-refactor` 标签。
- baseline 之后再删除宝塔占位 `.htaccess`，使删除本身可审查和回滚。

### Phase 1：SQLite inbox/outbox

- 实现 schema、业务事务和 legacy 导入。
- 先以仓储契约测试锁定迁移正确性。
- 切换 runtime 后确认不再写 JSON。

### Phase 2：纯 staging MCP 与宿主发送

- 删除 MCP 的微信凭据、目标、HTTP 和 DB。
- final batch 先入 outbox，再由宿主发送。
- 修复 fingerprint 冲突与 uncertain 语义。

### Phase 3：删除死路径并简化编排

- 删除 structured reply、reply policy、MapLocationResolver。
- 收敛为 sync、conversation、Codex、delivery 四段清晰流程。
- 删除仅服务 legacy fake 的测试和分支。

### Phase 4：测试工程化

- 重组测试目录和共享 support。
- 加入真实 SQLite、并发 barrier、SIGKILL 恢复、安全探针和 CI。
- 重写 live 测试的显式目标与发送确认。

### Phase 5：验收与对抗 review

- 完成 `docs/acceptance.md` 全部自动项。
- 运行真实 Codex＋假微信。
- 最后运行一个显式目标、单场景、accepted-only 的真实微信测试。
- 分别进行极简性、可靠性、安全隐私三轮对抗 review，修复所有成立的高/中风险问题。

## 方案否决条件

出现以下任一项即视为方案不合格：

- 只是把原 JSON getter/setter 改写成 SQL。
- state DB 与 journal DB 继续分裂。
- MCP 仍拥有真实发送凭据或能力。
- 为每张表增加单实现 interface/repository/DAO/service。
- 在网络或 Codex 调用期间持有事务。
- 通过 WAL 暗示支持多实例。
- live 测试自动挑选真实客户。
- 用特定图片案例污染通用 SOP。
