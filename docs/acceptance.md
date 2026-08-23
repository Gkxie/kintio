# 重构验收目标

本文档记录项目迭代过程中真实发生过的问题。重构不是以“测试能跑”为完成，
而是必须逐项满足这些可判定目标。

表格最后一列记录重构启动时的基线状态；完成后的可执行证据以
`test/acceptance-map.json` 和门禁输出为准。

基线状态说明：

- `covered`：当前已有较强自动化覆盖；重构后仍需保留。
- `partial`：只有主路径或假实现覆盖。
- `missing`：当前没有可靠验收，或实现仍有风险。
- `manual`：属于部署基础设施，只做运维验收。

## 接入与微信 API

| ID | 历史问题 | 重构后的验收标准 | 重构前 |
|---|---|---|---|
| G01 | 微信回调 URL 认证 | 合法 GET 解密并返回 `echostr`；错误签名、ReceiveID、Base64、padding、长度均拒绝且不触发同步 | partial |
| G02 | 回调不能等待 Codex | 即使后台永不结束，POST 仍立即返回 `success`；超过 1 MiB 返回 413 | covered |
| G03 | CorpID/Secret 与 token | 配置必须成对；并发 token 请求只发一次；过期仅重试一次；超时与 errcode 分类 | partial |
| G04 | `sync_msg` 分页与游标 | 空页继续分页；仅 `has_more=1` 且无新 cursor 时失败；页面消息与 cursor 在同一 SQLite 事务落库 | partial |
| G05 | 未知消息不能阻塞 | 未知类型不唤醒 Codex、不下载媒体、不回复，但 cursor 正常推进 | partial |

## 授权与人工接管

| ID | 历史问题 | 重构后的验收标准 | 重构前 |
|---|---|---|---|
| A01 | 未授权用户必须静默 | 所有消息类型均为 0 Codex、0 媒体下载、0 回复、0 thread 创建 | partial |
| A02 | 连续三次精确暗号 | 干扰、空格、非文本、不同客服会重置；重复 msgid 不计数；只允许 `1→2→3` | partial |
| A03 | 第三次确认不经 Codex | 固定确认直接进入 outbox，最多真实发送一次 | partial |
| A04 | 授权崩溃恢复 | 授权与确认 outbox 同事务；确认发送前后 SIGKILL 均不重复 | missing |
| A05 | 授权作用域 | 动态授权明确按企业 external user 全局生效；不同 open_kfid 不重复授权；撤销行为可判定 | missing |
| H01 | `origin=5` 人工接管 | 人工接管后客户消息不调用 Codex；“批准”不产生授权 | covered |
| H02 | 结束人工接待 | `change_type=3` 解除抑制；其他人工状态继续抑制 | partial |
| H03 | active turn 中人工接管 | 人工状态到达后，尚未提交的 staged 回复必须取消 | missing |
| H04 | 人工期间上下文 | 微信 API 实际返回的人工/客户消息进入 held；恢复后只读交接一次；平台未返回的历史不作保证 | missing |
| H05 | 暂停文件竞态 | 暂停后不接新任务；active turn 在写 outbox 前再次检查暂停状态 | missing |
| H06 | 微信人工/API 模式互斥 | 本地结束状态只解除内部抑制；平台未恢复 API 时明确要求控制面操作，不虚假报告自动切回 | manual |

## 消息领域与上下文

| ID | 历史问题 | 重构后的验收标准 | 重构前 |
|---|---|---|---|
| C01 | 每客户上下文隔离 | `(open_kfid, external_userid)` 唯一绑定 thread；跨客户、跨客服不串线；重启后恢复 | partial |
| C02 | 链接卡片曾被忽略 | title、desc、URL 进入同一客户上下文，Codex 可据此回答 | covered |
| C03 | 非原生消息摘要 | voice/video/file/location/card/miniprogram/menu/Channels/note 均产生带类型与来源标记的结构化摘要，内容仍视为不可信输入 | covered |
| C04 | 不做无意义媒体解析 | voice/video/file 下载次数必须为 0，不伪称听过、看过或打开过 | partial |
| C05 | 递归聊天记录 | 支持嵌套、畸形 JSON、深度与条数上限；保留发送者；不泄漏 media_id | covered |
| C06 | 图片为原生输入 | 顺序正确、魔数识别、大小限制；成功、异常、steer、退出后均清理临时文件 | partial |
| C07 | 完整上下文不等于渠道状态 | Codex thread 保留输入/输出；微信 accepted/failed/uncertain 作为独立渠道事实注入 | partial |

## 输出格式与工具边界

| ID | 历史问题 | 重构后的验收标准 | 重构前 |
|---|---|---|---|
| O01 | 输出格式收敛 | 只支持 text/image/link/miniprogram/location；无 menu/voice/video/file 发送工具 | covered |
| O02 | 模型不能选择客户 | 工具参数无目标 ID；真实目标只在宿主绑定 | covered |
| O03 | 地址应发原生位置 | 有可靠坐标时发 location；多个位置最多五条且不加冗余文字 | partial |
| O04 | link 与 location 区分 | 地图 URL 不冒充坐标；普通公网 URL 才能成为 link；私网 URL 拒绝 | partial |
| O05 | 小程序字段不得猜 | 只有可靠来源确认 appid/pagepath 才发送，否则降级 | partial |
| O06 | 客户原图重发 | 只允许当前会话未过期的 `media:N`；跨客户、过期、类型错误全部拒绝 | partial |
| O07 | 五条额度和 UTF-8 | 批次发送前整体预检；每条 ≤2048 字节且不切断字符；总数 ≤5 | partial |
| O08 | 原生发送失败兜底 | 每种格式最多一次安全文字兜底；uncertain 禁止自动重试与兜底 | partial |

## Steering 与并发

| ID | 历史问题 | 重构后的验收标准 | 重构前 |
|---|---|---|---|
| S01 | 连发消息曾逐条排队 | active turn 的后续消息使用 `turn/steer`，只形成一轮最终交付 | covered |
| S02 | steering 前工具曾真实发送 | MCP 永远无副作用；只在 `turn/completed` 后由宿主提交 | partial |
| S03 | `deferSends` 曾漏传 | 删除该安全开关；staging MCP 无凭据、无网络、无 DB，结构上不可能真发 | missing |
| S04 | steering 边界曾取错 | 以匹配 client ID 的最后 `UserMessage` 完成事件为边界 | covered |
| S05 | 多次混合 steering | 2、3、5、10 条 text/image/link 连发后，只提交最后边界后的完整批次 | missing |
| S06 | 淘汰草稿消耗额度 | steering 前 staged 调用不消耗最终批次的五条额度 | missing |
| S07 | 多客户并发 | 慢客户 A 不阻塞 B；同用户不同 open_kfid 完全隔离 | missing |
| S08 | 完成边界竞态 | completed 前到达必须 steer；completed 后到达必须新开 turn | missing |

## 图片生成与多轮编辑

| ID | 历史问题 | 重构后的验收标准 | 重构前 |
|---|---|---|---|
| I01 | 生成成功却只发失败文字 | 成功 imageGeneration 优先于文字兜底，真实上传并发送图片 | covered |
| I02 | 多个生成结果 | 只选最后 steering 后最后一个有效 PNG/JPEG；失败、畸形、超限结果忽略 | partial |
| I03 | 模型跳过生成 | 明确编辑意图且有当前/最近成品时，只允许一次强制生成重试 | covered |
| I04 | 生成图临时文件 | 成功、API 失败、模型失败和进程退出后均清理 | partial |
| I05 | 下一轮错误声称失败 | 渠道只记录 accepted；客户明确评价上一张图时，该反馈可证明其观察到结果，此时不得声称无成品或生成失败 | covered |
| I06 | SOP 不能拟合单个案例 | 至少三个互不相关的编辑意图验证“只改明确属性”；具体场景只是 fixture，不进入生产规则 | missing |
| I07 | 多轮编辑上下文 | 最近生成结果仍在同一 thread；后续指令作为 delta；SOP 不添加未要求修改；宿主发送最后有效结果 | partial |
| I08 | 全链路曾 mock 下游 | live 测试只 mock sync 输入，其余 Codex 与微信链路真实；显式目标与 fixture | partial |
| I09 | 测试通过但客服未收到 | 自动验收只证明 API accepted，uncertain 失败；异步 fail 与客户端显示属于独立部署 smoke/人工验收 | missing |

## 持久化、恢复与幂等

| ID | 历史问题 | 重构后的验收标准 | 重构前 |
|---|---|---|---|
| R01 | 稳定 msgid 与重复发送 | 同 source msgid/send index 始终得到相同 client msgid；accepted/uncertain 不重发 | partial |
| R02 | 相同 key 内容变化 | fingerprint 不一致必须报 invariant error，不能复用旧回执 | missing |
| R03 | accepted 不等于送达 | accepted 后 `msg_send_fail` 精确更新 failed 与 fail_type | covered |
| R04 | active turn 崩溃恢复 | outbox 前恢复后生成一次；pending 恢复后发送一次；sending 转 uncertain；accepted 不再发送；部分批次只继续未开始项 | missing |
| R05 | 游标与 inbox 原子性 | 页面消息与 cursor 同事务；cursor 不会越过未持久化消息 | missing |
| R06 | final batch 与 outbox 原子性 | 最终批次、主消息 ready、steer absorbed 同事务 | missing |
| R07 | uncertain 语义 | uncertain 只表示可能已发送，不能表述为 confirmed/delivered | missing |
| R08 | 跨客服 msgid 冲突 | 内部 message_key 包含 open_kfid；primary、outbox、稳定 msgid、spool 不使用裸 msgid | missing |
| D01 | JSON 全量重写 | 运行时不再序列化全状态；单条更新执行恒定数量参数化 SQL，100/10k/100k 历史量下 SQL 数量不增长 | missing |
| D02 | JSON 与旧 journal 迁移 | cursor/thread/auth/session/pending/media/receipt 全量导入；幂等；失败保留原文件 | missing |

## 安全与部署

| ID | 历史问题 | 重构后的验收标准 | 重构前 |
|---|---|---|---|
| SEC01 | 搜索与本机访问策略 | web search 可用；模型遵循项目指令拒绝 shell、环境变量、本地文件和私网 HTTP 请求 | missing behavior test |
| SEC02 | Secret 与跨客户泄漏 | prompt、日志、DB 输出不含 Secret；客户 A 不能访问 B 的媒体与内容 | partial |
| SEC03 | root 通配符 | root 下 `WECOM_ALLOWED_USER_IDS=*` 启动失败 | missing test |
| SEC04 | 文件权限 | DB 0600、临时目录 0700、临时文件 0600；启动时清理孤儿文件 | partial |
| SEC05 | staging MCP 最小权限 | MCP 无 CorpID、Secret、目标 ID、HTTP 客户端、DB 路径 | missing |
| DEP01 | 不再由宝塔托管 Node | 外层 `index.ts` 经 strict TypeScript 构建，由 `npm start` 运行 `dist/index.js`；SIGTERM drain 后释放 8888；无宝塔文件 | missing |
| DEP02 | 项目配置不影响本机 CLI | turn 明确传项目 model/effort；用户级 Codex 配置测试前后哈希不变 | partial |
| DEP03 | SSL/SNI/IPv6 历史问题 | 独立运维 smoke：`nginx -t`、双域名 SNI、IPv4/IPv6；不耦合进 Node 单测 | manual |
| DEP04 | 误启动两个实例 | 第二进程拒绝启动；存活进程锁不可抢；SIGKILL 后 stale lock 可回收且 DB 完整 | missing |

## 总体验收门槛

重构完成必须同时满足：

1. 默认确定性测试 `0 fail / 0 skip`。
2. 行覆盖率 ≥90%，分支 ≥80%，函数 ≥90%。
3. `PRAGMA integrity_check` 和 `foreign_key_check` 通过。
4. 运行时不再读写 JSON 状态文件，旧文件只作为迁移备份。
5. staging MCP 不拥有任何真实发送能力。
6. 生产路径删除 structured reply、reply policy 和 MapLocationResolver 死分支。
7. 真实 Codex＋假微信 opt-in 通过。
8. 仅 mock 上游、其余全真实的 live 测试必须显式指定目标、单场景、accepted-only。
9. 三组对抗 review 均无未处理的高/中风险问题。
10. 生产代码满足下述 baseline/目标；不新增单实现 interface、DAO、事件总线或 DI 容器。

自动完成门槛不包含 `manual` 项。重构前生产 JS baseline 为 6,358 行。用户追加 strict
TypeScript 后，源文件会包含不会进入运行时的类型声明，因此可比的 5,100 行目标改为普通
`tsc` 未压缩产物 `dist/index.js + dist/src/**/*.js`，原 5,100 行目标在最终安全 review 后为
bubblewrap 的 MCP 独立禁网边界计入显式预算，最终上限为 5,200 行；
`index.ts + src/**/*.ts` 另行报告，不设
鼓励删类型的物理行门槛。两者都必须通过极简性 review，禁止压缩排版、降低类型质量、移动
类型到统计目录外或合并无关职责凑行数。

`test/acceptance-map.json` 必须为每个 ID 标记 `deterministic`、`agent-eval` 或 `manual`：

- C04 的“不下载媒体”是 deterministic；模型不得伪称理解内容是 agent-eval。
- O05 的字段/URL 格式是 deterministic；来源是否足以支持卡片是 agent-eval，缺资料场景 10/10
  不得调用 miniprogram。
- I06 使用至少三个互不相关编辑意图、每个运行两次，6/6 必须选择生成工具且 revised prompt
  只描述请求 delta；像素质量为 manual。
- I07 的同 thread、delta 输入和最后结果发送是 deterministic；视觉身份保持为 manual。
