<div align="center">

<h1>
  <img src="assets/logo.svg" alt="Kintio" width="320" />
</h1>

**把聊天通道连接到你掌控的 Agent。**

[English](README.md) | 简体中文

</div>

这是本项目唯一的中文入口。详细文档、贡献流程与版本说明统一以英文维护。

Kintio 把聊天通道连接到你电脑上运行的 Agent。你可以从聊天中下达任务、补充指令，
并在同一会话收到结果。当前版本直接使用宿主机上已经认证的 Codex CLI 及其配置。

## 快速开始

需要 Node.js 24+，并确保运行 Kintio 的同一系统用户已经登录 Codex CLI。

```bash
npm install --global @kin-tio/cli
codex login status
```

### 微信 iLink

iLink 是建立 Kintio 对话的最短路径：扫码后通过长轮询收发消息，不需要公网地址、回调服务、
配置文件或 `.env`。

```bash
kintio ilink start
```

首次在交互终端运行时，命令会直接显示二维码。请在五分钟内使用微信扫码；Kintio 会把账号
加密保存到 `~/.kintio`，继续启动并在后台运行 iLink。之后向新出现的 Bot 发送消息即可使用，
再次启动无需重复扫码。

> 本机扫码建立的 iLink 账号会继承宿主 Agent 配置允许的能力。只应让获准控制宿主 Agent
> 的人扫描二维码。

查看运行状态和日志：

```bash
kintio status
kintio logs --lines 100
```

### 管理 iLink 账号

| 目的 | 命令 |
| --- | --- |
| 只登录账号，不启动监听 | `kintio ilink login` |
| 查看已登录账号 | `kintio ilink list` |
| 启动账号 | `kintio ilink start` |
| 停止账号 | `kintio ilink stop` |
| 永久删除账号及其 Kintio 数据 | `kintio ilink delete` |
| 交给外部进程管理器托管 | `kintio ilink start --foreground` |

只有一个账号时会自动选中；存在多个账号时，交互终端会显示可搜索的选择面板。脚本调用
`start` 和 `stop` 时应显式传入 `--account <账号标识>`；非交互删除始终需要同时传入
`--account` 和 `--yes`。删除只清理 Kintio 本地状态，不会删除服务端 Bot，也不保证服务端
令牌失效。

图形界面或非交互调用方可以把临时二维码输出为原始 PNG：

```bash
kintio ilink login --qr-output ~/.kintio/ilink-login.png
```

二维码最多等待五分钟，PNG 仅在登录过程中临时存在。完整的二维码、多账号和非交互规则见
英文[部署指南](docs/setup.md)。

### 公网回调通道

需要接收公网 HTTPS 回调的通道使用部署配置：

```bash
kintio setup
kintio start
kintio status
kintio logs --lines 100
```

`kintio setup` 会在 `~/.kintio` 下创建私有实例、安装 Agent Skill，并写入通道配置模板。
回调凭据、授权流程和首次回复见英文[部署指南](docs/setup.md)。WeChat KF 部署也可以在同一个
Service Runtime 中启用 iLink。

## 核心能力

- 每个通道身份使用独立 Agent Thread。
- 后续消息可以调整正在执行的任务，不必排在过时指令之后。
- SQLite Inbox 支持重启恢复，并优先处理实时消息。
- MCP 动作只作用于当前会话，投递结果明确区分已受理、失败和不确定。

消息链路、身份边界、恢复机制和源码入口见英文[架构文档](docs/architecture.md)。

## 当前适配器

| 适配器 | 接收 | 发送 | 接入方式 |
| --- | --- | --- | --- |
| Weixin iLink | 文字、图片；其他类型转为明确摘要 | 文字、图片 | 扫码绑定后长轮询 |
| WeChat KF API | 文字、图片；其他类型转为明确摘要 | 文字、图片、链接、小程序、位置 | 公网 HTTPS 回调 |

不同通道的用户、媒体引用和 Agent Thread 不会被隐式合并，回复能力始终受原会话约束。

## 运维和升级

```bash
kintio status
kintio logs
kintio restart
kintio update
```

`kintio upgrade` 与 `update` 完全等价。通过 npm 或 pnpm 识别出的全局安装可以原地升级，
不会改动 Agent 或通道配置；存在正在执行的 Agent 任务时，Kintio 会拒绝升级。

## 安全边界

Kintio 不会把通道密钥、稳定用户标识、原始媒体 ID 或数据库路径注入 Agent。本机 iLink
登录代表宿主明确授权，但项目级能力限制不是操作系统沙箱。完整信任边界和私密漏洞报告方式
见英文[安全策略](SECURITY.md)。

## 项目状态与英文文档

Kintio 处于 `0.x` 阶段，正在稳定通道、身份、恢复和 Agent Runtime 契约，以支持更多适配器。

- [Setup guide](docs/setup.md)：部署到收到第一条 Agent 回复。
- [Architecture](docs/architecture.md)：消息链路、边界与源码入口。
- [Roadmap](ROADMAP.md)：长期方向和 `0.x` 优先级。
- [Changelog](CHANGELOG.md)：各版本的用户可见变化。

Weixin iLink 协议实现涉及的第三方归属和许可证见
[THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES)。Kintio 是独立开源项目，与腾讯、微信、Weixin
及其他通道提供方不存在隶属、授权、背书或官方代表关系。

## 参与贡献

参与开发前请阅读英文[贡献指南](CONTRIBUTING.md)，然后执行仓库统一验证入口：

```bash
corepack enable pnpm
pnpm install --frozen-lockfile
pnpm test
```

默认测试使用临时 SQLite 和模拟的通道、Agent 边界，不会连接真实服务。行为规范、维护流程和
许可证分别见 [Code of Conduct](CODE_OF_CONDUCT.md)、[Maintainer guide](MAINTAINING.md) 和
[Apache License 2.0](LICENSE)。
