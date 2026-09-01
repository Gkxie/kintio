<div align="center">

<h1>
  <img src="assets/logo.svg" alt="Kintio" width="320" />
</h1>

**把聊天通道连接到你掌控的 Agent。**

[English](README.md) | 简体中文

</div>

这是本项目唯一的中文入口。详细文档、贡献流程与版本说明统一以英文维护。

把 Kintio 部署在运行 Agent 的机器上，授权用户就能在微信等受支持的聊天入口中直接下达
任务、补充或改变指令，并在原会话中收到结果。Kintio 负责连接聊天与 Agent，同时隔离不同
通道的身份、状态和回复能力；当前 Agent Runtime 使用部署主机上已经登录的 Codex CLI。

## 核心能力

- 每个适配器身份使用独立 Agent Thread，不跨通道合并身份或历史。
- 用户补充指令时可以调整正在执行的任务，避免旧指令排队产生过时回复。
- SQLite Inbox 支持重启恢复，并优先处理实时消息。
- 应用 Supervisor 统一管理 HTTP 回调、轮询监听和未来长连接通道；Hono 只是 HTTP 适配器，
  不是进程生命周期入口。
- MCP 动作只作用于当前会话，不向 Agent 暴露渠道密钥、原始用户标识或数据库路径。
- 投递结果明确区分已受理、失败和不确定；结果不确定时不会盲目重发。

目前一套部署共享一份 Agent Runtime 登录态，不是每个聊天用户绑定独立 Agent 凭据、额度和
工作目录的多租户平台。

## 当前适配器

| 适配器 | 接收 | 发送 | 接入方式 |
| --- | --- | --- | --- |
| WeChat KF API | 文字、图片；其他类型转为明确摘要 | 文字、图片、链接、小程序、位置 | 公网 HTTPS 回调 |
| Weixin iLink | 文字、图片；其他类型转为明确摘要 | 文字、图片 | 扫码绑定后长轮询 |

## 最小启动步骤

需要 Node.js 24+、已安装并登录的 Codex CLI，以及至少一个
受支持适配器的凭据。

```bash
npm install --global @kin-tio/cli
kintio setup
codex login status
```

`kintio setup` 会在 `~/.kintio` 创建私有实例目录、安装内置 Agent Skill，并生成渠道配置
模板 `.env`。macOS/Linux 使用 `0600`，Windows 则限定在当前用户目录的 ACL
边界内。默认不启用任何适配器；请按英文
[部署指南](https://github.com/Gkxie/kintio/blob/master/docs/setup.md)配置 WeChat KF API，或为已有 Weixin iLink 绑定设置
`ILINK_ENABLED=true`。

```bash
kintio start
kintio status
kintio logs --lines 100
```

启动后应确认 `kintio logs` 包含 `Hono server is listening on port 8888`；投入使用前仍需按
部署指南完成回调或绑定验证。需要前台进程时使用 `kintio run`；现有源码目录部署可以在完成
部署指南中的一次性进程管理器迁移后，继续使用原数据库和配置。
源码构建与贡献者开发环境见英文
[贡献指南](https://github.com/Gkxie/kintio/blob/master/CONTRIBUTING.md)。

## 英文文档

- [Setup guide](https://github.com/Gkxie/kintio/blob/master/docs/setup.md)：配置到收到第一条 Agent 回复。
- [Architecture](https://github.com/Gkxie/kintio/blob/master/docs/architecture.md)：消息链路、模块边界与身份隔离。
- [Roadmap](https://github.com/Gkxie/kintio/blob/master/ROADMAP.md)：长期方向和 `0.x` 优先级。
- [Contributing guide](https://github.com/Gkxie/kintio/blob/master/CONTRIBUTING.md)：参与方式与验证要求。
- [Security policy](https://github.com/Gkxie/kintio/blob/master/SECURITY.md)：信任边界与私密漏洞报告。
- [Changelog](CHANGELOG.md)：用户可观察的版本变化。

Kintio 处于 `0.x` 阶段，使用 [Apache License 2.0](LICENSE)。Weixin iLink 协议实现所涉及的
第三方归属和许可证见 [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES)。

Kintio 是独立开源项目，与腾讯、微信、Weixin 及其他通道提供方不存在隶属、授权、背书
或官方代表关系。
