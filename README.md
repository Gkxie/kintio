# WeChat Customer Service Codex Bridge

把企业微信“微信客服”消息接入 Codex app-server 的 Hono 服务。项目只监听
`8888`，不管理 Nginx、证书或宝塔配置。

## 运行链路

```text
加密回调 → 立即 success → kf/sync_msg → SQLite inbox
→ 授权/人工/暂停门禁 → Codex turn/start 或 turn/steer
→ 无副作用 staging MCP → SQLite outbox
→ 宿主 kf/send_msg → accepted/failed/uncertain 回执
```

- 一页消息和 cursor 在同一个 SQLite 事务提交。
- 每个 `(open_kfid, external_userid)` 使用独立 Codex thread。
- active turn 收到追问时调用 `turn/steer`，不排队生成旧答案。
- 工具只暂存候选；模型完成后，宿主才选择最后 steering 边界之后的批次。
- 微信真实发送最多五条，批次在发送前整体预检。
- 微信网络请求期间不持有 SQLite 事务。

## 授权与人工接管

静态授权由 `WECOM_ALLOWED_USER_IDS` 配置。动态授权开启后，未授权客户必须在
同一个 `open_kfid` 连续发送三次精确暗号；第三次由宿主直接回复
“暗号确认，请继续对话”，不唤醒 Codex。

授权身份按企业内 `external_userid` 全局生效，因此同一客户进入另一个
`open_kfid` 不需要重复授权；会话和 thread 仍按两者组合隔离。项目当前服务一个
CorpID；多企业部署时应把 CorpID 加入授权主键。

未授权客户的所有消息均为：零回复、零 Codex、零媒体下载。`origin=5` 或人工接待
状态会立即提高会话 epoch，active turn 即使随后完成也无法写入 outbox。人工期间
微信 API 实际返回的消息会保存为一次只读交接上下文；平台没有返回的历史无法补齐。

## 消息能力

Codex 原生输入只接受：

- 文本；
- 图片（授权和门禁通过后才下载，临时文件用后删除）。

语音、视频、文件、位置、链接、小程序、视频号、笔记、菜单和聊天记录只生成明确的
文本摘要。语音/视频/文件不会下载、转写或伪称已理解。聊天记录递归解析并限制深度与
条数，不把 `media_id` 暴露给模型。

允许发送的微信原生格式只有：

- `text`
- `image`
- `link`
- `miniprogram`
- `location`

地址必须有可靠经纬度才发送位置卡片；地图链接不是位置。小程序必须精确核实
`appId`、`pagePath` 和公开来源。客户图片只能用当前会话、未过期的 `media:N`
引用。原生格式确定失败时可使用预留的一条文字 fallback；发送结果为 `uncertain`
时绝不自动重试或触发 fallback。

## 安全边界

staging MCP 不拥有 CorpID、Secret、客户 ID、`open_kfid`、原始 `media_id`、数据库
路径或微信 HTTP 客户端。它只校验工具字段与 `media:N` 语法；宿主在 outbox 事务前用
当前会话目录再次验证媒体所有权。真实目标由宿主从 inbox 绑定，模型无法选择收件人。
MCP 另运行在无网络的嵌套 bubblewrap namespace 中。

Codex 直接复用当前运行用户已经登录的本机 Codex CLI，并使用项目级配置：

- read-only sandbox；
- 禁用 shell、登录 shell、本机图片查看和子代理；
- command network 关闭；
- 托管 web search 可独立设为 live；
- apps、browser、computer、plugins、unified exec 等额外能力显式关闭；
- `codex-workspace/AGENTS.md` 与每轮提示禁止读取本机内容、访问私网或跨客户取数；
- 不复制、不改写本机 Codex 凭据或用户级配置。

这是按用户选择采用的提示词和工具暴露边界，不是 Codex 主进程的 OS 级文件隔离：
本机登录态会使 app-server 使用同一个 `CODEX_HOME`，提示词不能提供和容器、独立用户或
mount namespace 相同的强制保证。staging MCP 仍单独运行在无网络 bubblewrap namespace
中，且不接收微信凭据、客户目标或数据库路径。

当进程以 root 运行时，`WECOM_ALLOWED_USER_IDS=*` 会拒绝启动。

## 持久化与恢复

桥接服务的业务状态统一保存在 `data/wecom.sqlite`，启用 WAL、`synchronous=FULL`、外键和
5 秒 busy timeout。数据库与临时文件权限分别为 `0600`，临时目录为 `0700`。

Codex thread 和客户提示历史由本机 CLI 另行持久化在共享的 `CODEX_HOME`，不在业务 SQLite
保留期内；撤销客户授权也不会自动删除这部分 CLI 历史。需要统一删除/到期策略时，应改用
专属系统用户或独立 `CODEX_HOME` 并配置对应的 Codex 历史治理，而不是依赖本项目的 SQLite
cleanup。

内部消息键是 `SHA256(open_kfid + NUL + msgid)`；无 msgid 事件按 cursor、页内位置
和 payload 生成稳定键。outbox 保存微信 API 可直接发送的 exact payload，稳定 client
msgid 独立保存。

正式语义：

- Codex 输入至少一次；
- 微信自动发送至多一次；
- `accepted` 只表示微信 API 接受，不表示客户端已展示；
- 进程在 `sending` 中退出时，重启后变为 `uncertain`，可能实际发送零次或一次，绝不盲重试。

旧版 `wecom-state.json` 和独立发送 journal 使用显式离线命令迁移，校验完整性后原子安装
SQLite，并把旧文件改名为带时间戳的备份：

```bash
pnpm run migrate:legacy
```

若旧状态仍存在而新 DB 不存在，主服务会 fail closed 并提示先迁移，不会悄悄创建空库。
第二实例由 O_EXCL PID 锁拒绝。

## 配置

复制 `.env.example` 为 `.env`，至少填写：

```dotenv
PORT=8888
WECOM_CALLBACK_TOKEN=...
WECOM_ENCODING_AES_KEY=...
WECOM_CORP_ID=...
WECOM_KF_SECRET=...
CODEX_MODEL=gpt-5.6-luna
CODEX_REASONING_EFFORT=none
```

回调 Token、EncodingAESKey 和微信客服 Secret 是三个不同值。`.env`、`data/` 和
`node_modules/` 已被 Git 忽略。

## 启动与运维

要求 Node.js `>=22.13.0`，包管理器固定为 pnpm 10.34.5，项目使用当前最新版
TypeScript（lockfile 当前锁定 TypeScript 7）。生产代码只由 `tsc` 编译；测试、开发和
运维脚本使用 Node 原生 `--experimental-strip-types`，不依赖 `tsx` 或 esbuild。

```bash
corepack enable pnpm
pnpm install --frozen-lockfile
pnpm start
```

先确保启动服务的同一系统用户执行 `codex login status` 能看到有效登录态。项目不会复制
或改写该登录态。`pnpm start` 会先执行 strict TypeScript 构建，再运行 `dist/index.js`；本地开发可使用
`pnpm run dev`。暂停状态进入 SQLite：

```bash
pnpm run pause
pnpm run status
pnpm run resume
```

动态授权可由运维显式查询或全局撤销：

```bash
pnpm run auth -- status wm_external_userid
pnpm run auth -- revoke wm_external_userid
```

SIGTERM/SIGINT 会先关闭 8888 listener，再限时等待同步、Codex 和投递任务。

## 测试

```bash
pnpm test
pnpm run test:coverage
```

默认测试使用真实临时 SQLite 和 fake 外部边界，必须 0 fail / 0 skip。真实 Codex 与
真实微信测试不参与默认发现：

```bash
RUN_REAL_CODEX=1 pnpm run test:agent

LIVE_WECOM_OPEN_KFID=... \
LIVE_WECOM_EXTERNAL_USER_ID=... \
LIVE_WECOM_ALLOWLIST=... \
LIVE_SCENARIO=text \
LIVE_WECOM_ACK=SEND_REAL_MESSAGE \
pnpm run test:live
```

live 测试只 mock 上游输入，目标必须显式提供并同时存在于独立 allowlist。自动结果只证明
API `accepted`；客户端显示和异步 `msg_send_fail` 属于部署 smoke/人工证据。

历史问题与验收标准见 `docs/acceptance.md`，架构决策和测试工程分别见
`docs/refactor-plan.md`、`docs/testing-strategy.md`。
