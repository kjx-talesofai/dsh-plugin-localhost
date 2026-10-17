# dsh-plugin-localhost

> 一个面板，回答"这台机器上现在跑着什么、哪个目录、哪个会话开的、怎么关掉"。

agent 在开发里起服务是常态：`pnpm dev`、`python -m http.server`、一个 `dist/` 静态页。它们是短暂的，但**不会自己消失**——三个小时后你没死，那个端口也没死。这个插件把"起服务"变成一次**登记**，于是端口不用猜、目录不会丢、关掉有地方点。

<details>
<summary>中文</summary>

## 它做什么

**两种东西，都归它管；第三种它老实承认管不了。**

| 类型 | 谁在跑 | 生命周期 |
|---|---|---|
| `静态页` | 插件自己（127.0.0.1 上的一个小服务器） | 跟着 DSH 一起关 |
| `命令` | 插件通过 Harness 的 subprocess 服务启动 | 插件停它就停，DSH 退出时全部停 |
| 别的进程 | agent 自己用 bash 起的 | **不在这里**。杀不掉的进程不该显示成"运行中" |

这不是洁癖。一个后台进程如果没人拥有，它就会活过它该活的时间——见 [`docs/plan.md`](docs/plan.md) 里那四个活了十一天的东西。

## 装

```
github:kjx-talesofai/dsh-plugin-localhost#v0.3.0
```

装完**重启桌面端**（host 半边只在启动时加载）。

## agent 怎么用

给 agent 的是一个工具 `serve`，不是一堆 bash：

```jsonc
{ "action": "register", "kind": "spawned", "name": "preview",
  "dir": "/path/to/project", "cmd": "pnpm dev --port $PORT",
  "path": "/" }

{ "action": "register", "kind": "static", "name": "deck",
  "dir": "/path/to/dist" }
```

返回里带 `port` 和 `url`。**端口是插件分的（8840–8899），不是 agent 挑的**——所以"这个工作区开过哪些服务"这个问题有答案，而不是靠回忆。

其他动作：`list` / `start` / `stop` / `logs`。`logs` 返回最近的输出，排错不用截图。

## 面板

侧边栏里，紧挨在 Tailscale Remote Access 下面。每行：状态点、名字、类型、端口、状态。展开后有：

- **目录** —— 点「用 Finder 打开」
- **入口文件**（静态页）—— 点「显示入口文件」，Finder 里直接选中它
- **登记会话** —— 点「跳到会话」，回到当初开它的那个对话
- **日志** —— 最近 400 行，运行中会自己滚

行上的按钮：打开 / 启动 / 停止 / 收起。

## 老实说（边界）

- **只登记它自己起的**。agent 用 bash 起的服务，这个面板看不见——它杀不掉，就不能声称拥有。
- **DSH 退出 = 全部停止**。重启后所有条目显示"已停止"，需要手动点启动；不会偷偷帮你拉起来。
- **端口是分给它的**，所以别在别的脚本里硬编码 8840。想要固定端口就在 `cmd` 里自己用 `$PORT`。
- **静态页由它自己发**，不是复制文件：`dir` 改了立刻生效，`dir` 删了就 404。
- **只在 127.0.0.1 上**。这个端口没有认证，不要以为它是个"分享"按钮；要给别人看，走 Tailscale。
- **从手机打开**：面板会读 `tailscale serve status`，把已经发布到 tailnet 的端口配上远端地址；此时「打开」在**你的手机浏览器**里打开那个地址，而不是让 Mac 弹浏览器。没发布的端口在手机上不给「打开」按钮，并明说只在本机可访问。
- 静态页的 SPA 回退**只对浏览器导航生效**（`Accept: text/html`），这样 `/etc/hosts` 这类路径不会假装成路由。

## Compatibility

实测于 **macOS（Apple Silicon）+ DSH Desktop 0.2.1-rc.2**。依赖的上游契约：

| 契约 | 来自 |
|---|---|
| `webServer.register({ kind: 'exact', path })`，以及 `connection.admit(req)` 的准入栅栏 | `dsh-host-webserver`、`dsh-api-remotes` |
| `subprocess.spawn` 的句柄、`collected.*.readFrom(offset)`、`terminate()`，以及**服务销毁时杀掉所有在管进程** | `dsh-subprocess-local` |
| `ctx.tools.register` 的 `ToolDefinition`（`parameters` 里 `required` 写在字段内） | `dsh-tools` |
| `sidebar.panellist` / `main` 两个槽位，`order` 决定导航顺序 | `dsh-client-ui-sidebar`、`dsh-client-ui-layout` |
| `locale.bind(ns)` 支持 `{name}` 插值 | `dsh-client-locale` |
| `uiWorkspace.openSession(id)` 接受裸 session id | `dsh-client-ui-workspace` |

## 开发

```sh
npm test    # 45 条，不需要安装任何依赖
```

Host 半边没有运行时依赖，所以测试**真的 import 它**，用假 ctx 驱动：静态服务走真实 socket，spawned 走假 subprocess，断言的是 spawn 规格而不是"看起来跑了"。Client 半边按页面加载的方式在 `node:vm` 里求值，再用一个迷你 hooks 运行时把面板渲染出来断言。

没有构建步骤：`client.js` 就是发布物。

</details>

<details>
<summary>English</summary>

## What it does

Two kinds of things, both owned; a third it refuses to pretend about:

| Kind | Who runs it | Lifetime |
|---|---|---|
| `static` | this plugin (a small 127.0.0.1 server) | stops with DSH |
| `command` | this plugin, through the Harness subprocess service | stops when asked, and on DSH exit |
| anything else | the agent, with bash | **not listed here**. A process we cannot kill must not read as "running". |

The agent gets one tool, `serve`, instead of a pile of bash: it registers a directory or a start command and comes back with the assigned port and URL. Ports come from 8840–8899 and are assigned by the plugin, never typed by the agent — which is what makes "what did I start here" a question with an answer.

The panel sits under Tailscale Remote Access: status, name, kind, port, and one switch. Expand a row for the directory (reveal in Finder), the entry file, the registering session (jump back to it), and the log tail.

## Honest limits

- It lists only what it started. A server an agent began with bash is invisible — and unkillable — so it is not shown.
- DSH exit stops everything; after a restart every entry reads stopped and nothing restarts itself.
- Static pages are served from their directory, not copied; the port is not authenticated and is loopback-only.
- The SPA fallback applies to browser navigations only (`Accept: text/html`), so a missing file stays a 404.

## Development

```sh
npm test    # 45 tests, no install step
```

The Host half has no runtime dependencies, so the suite imports it and drives a fake context: the static server over a real socket, the spawned path through a fake `ctx.subprocess`. The Client half is evaluated as a script in `node:vm` and rendered through a small hooks runtime.

</details>

## License

[MIT](LICENSE) © 2026 Jiaxin Kou

<p align="center">
  <a href="https://hypersampling.com">
    <img src="https://assets.hypersampling.com/hyper-sampling-2.jpg" alt="hypersampling" height="38"/>
  </a>
</p>
