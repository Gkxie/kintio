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
codex login status
```

通过 npm 或 pnpm 全局安装后，可直接升级当前安装：

```bash
kintio update
```

`kintio upgrade` 是完全等价的别名。Kintio 不会猜测无法识别的安装目录，也不会
打断正在工作的 Agent；空闲的后台实例会按原来的 service 或 iLink 模式恢复。

iLink 可以完全独立使用，不需要 `setup`、`.env` 或公网 HTTP：

```bash
kintio ilink login
kintio ilink start
```

`ilink login` 完成一次扫码、加密保存凭据后退出，不会自行启动监听；`ilink start` 不启动 Hono 或 TCP 端口，
而是通过后台守护进程运行 iLink 长轮询和宿主 Agent。由外部进程管理器托管时可显式使用
`--foreground`。两者默认使用 `~/.kintio`。
存在多个账号时，先用 `kintio ilink list` 查看账号，再通过 `--account` 指定
`start`、`stop` 或 `delete` 的目标；正在运行时可继续执行 `start` 增加监听账号。

需要部署公网回调渠道时，再使用：

```bash
kintio setup
kintio start
kintio status
kintio logs --lines 100
```

具体配置见英文[部署指南](https://github.com/Gkxie/kintio/blob/master/docs/setup.md)。

图形界面或非交互调用方可以显式选择临时的原始 PNG，而不是解析终端字符：

```bash
kintio ilink login --qr-output ~/.kintio/ilink-login.png
```

目标文件必须直接位于所选 Kintio 实例目录中且不能预先存在；登录成功、过期、取消或失败后，Kintio 会自动删除该文件，并且
不会打印二维码原始内容。二维码五分钟后过期；该命令不会唤醒 Agent。通过本机命令建立的 iLink 身份代表宿主机
所有者的明确授权，后续对话直接继承宿主 Agent 配置，不再套用不可信渠道的能力限制。
只应让获准控制宿主 Agent 的人扫描该二维码。登录后运行 `kintio ilink start` 即可在不
启动 Hono 的情况下处理消息。

`kintio ilink delete --account <账号> --yes` 会不可恢复地删除该账号及其在 Kintio
中的凭据、会话、消息、媒体、发送记录和登录审计；`--yes` 为强制确认参数。

公网回调部署启动后，应确认 `kintio logs` 包含
`Hono server is listening on port 8888`。
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
