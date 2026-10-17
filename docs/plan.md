# Localhost — 设计与决策记录

## 1. 问题

agent 开发时会起服务。它们有三个共同点：

1. **端口是临时的**，但没人记得是哪个；
2. **启动命令只存在那次 bash 调用里**，会话一关就没了；
3. **进程不会自己死**。`pnpm dev` 跑在你 `cd` 进去的那个目录，跑多久就是多久。

第二点是这个插件的真正理由。用户的原话是："很多服务是依靠 agent 写 bash 启动的，我不一定记得怎么写。" 所以登记表里必须有**启动命令**，否则面板只能告诉你"8000 上有个东西"，而你仍然不知道该怎么把它再起一次。

## 2. 先例：四个活了十一天的进程

做这个设计的当天，机器上有四个 `palmifer __serve` 在跑：三个起于 10-06，一个起于 10-16，全部 `ppid=1`。它们是这样活下来的：

- palmifer 的 daemon 是**按状态目录**单例，不是按机器；
- 启动用了 `detached: true` + `unref()`，所以父进程退出它不退；
- pid 记在那个状态目录的 `daemon.pid` 里，而三个状态目录在 `/var/folders` 的临时目录里——**没有任何一条命令再指得到它们**，包括 `palmifer stop`。

三条教训直接写进了这个插件：

1. **spawn 必须走 `ctx.subprocess`**，因为它的契约里写着"服务销毁时终止所有在管进程"。`node:child_process` + detached 就是上一种做法。
2. **登记表必须记 cwd 和启动命令**，不能只记端口。端口是结果，不是身份。
3. **杀不掉的进程不登记**。面板显示"运行中"就必须能手起手落。

## 3. 为什么只有两种类型

M1 只做 `static` 和 `spawned`：

- `static` —— 一个目录，插件自己发。没有子进程，没有日志，跟着进程死。
- `spawned` —— 一条命令，插件通过 subprocess 起、收日志、停。

**不做 `observed`（观察 agent 用 bash 起的进程）**，理由不是懒：那种条目只能"看"，按钮全是假的；而且扫描 `lsof` 再猜命令行，猜错比不显示更糟。M2 再说，且必须带"收养"的明确语义（哪个进程、哪条命令、谁负责关）。

## 4. 端口由插件分配

和 cohub 那个"只暴露两个端口让 agent 往上绑"的直觉一致，只是本机版：不是共享端口，而是**插件分配、agent 接收**。

- 范围 8840–8899，避开常见开发端口（3000/5173/8000/8080）；
- 分配前 `probe` 一次，确认没人占；
- 启动前**再** probe 一次——中间这几秒可能被别人抢走，那时必须报错而不是假装起来了；
- 命令里用 `$PORT`（同时注入 `LOCALHOST_PORT`），所以 `pnpm dev --port $PORT` 天然正确。

**端口不是 URL 的唯一来源**：静态页也走自己的端口，而不是 `/svc/<id>/` 这种路径前缀。原因是 SPA 的绝对资源路径（`/assets/…`）在前缀下会碎掉，而路径重写 HTML 又救不了 JS 里的引用。一个端口换一次"零改写"，值。

## 5. 登记表是文件，不是 Config

`~/.dsh/localhost/services.json`。

Config 是**用户的偏好**，会被写进 profile 的 `cordis.patch.yml`，跟着插件配置走。而这里是**机器上的运行事实**：一条条带 cwd、会话 id、端口。把二十个服务的定义塞进配置补丁文件里，会让那个文件既不像配置也不好读。

分界很清楚：

- 定义（名字、类型、目录、命令、端口、登记会话）→ 文件，重启后还在；
- 运行态（pid、日志尾巴、退出码）→ 内存，重启即失。

**不做自动启动。** 重启后全部显示"已停止"。自动拉起一个你不知道的 dev server，是另一个层面的惊吓。

## 6. 面板上的三个"定位"

用户明确要的：服务或静态页在哪里、能定位到工作区、能定位到会话。

- **目录** → `open <dir>`（Finder）
- **入口文件** → `open -R <file>`（Finder 里选中它）
- **会话** → `uiWorkspace.openSession(sessionId)`

会话是登记时记下的那个。M1 不区分"当前正在用它的会话"和"上次启动它的会话"——那需要跟踪谁在访问这个端口，代价远大于收益，而且会开始猜。面板上写的是"登记会话"，说的就是它记的那件事。

## 7. 几条实现上的硬决定

- **SPA 回退只对导航生效**（`Accept: text/html`）。否则 `/etc/hosts` 这种请求会被 index.html 接住，404 变成 200——测试里就是这么抓住的。
- **路径穿越在解析阶段就否定**：`resolve` 后必须仍在 root 下，否则 404，而不是靠 SPA 回退兜底。
- **日志在读的时候 drain**，不是只靠 700ms 的定时器。否则 `logs` 会给你一个空数组，因为它刚问了一个还没轮询过的服务。
- **`open` 是唯一不走 subprocess 的命令**：一次性、立即退出，没有生命周期可管，进登记表只会污染它。
- **准入栅栏复用 `connection.admit`**，和 `/api` 同一套规则；拿不到结论就 fail closed。

## 8. 测试：23 条

Host 半边没有运行时依赖，所以是真的 import 进来跑：

- 路由、工具、端口段都注册了；方法不对给 405
- 目录不存在 / 没有命令 → 400，而不是登记一条死条目
- 静态服务：真实 socket、content-type、SPA 回退只对导航、穿越被拒、停止后端口释放
- spawned：argv 是 `[shell, -lc, cmd]`、cwd、`PORT`、`stdio` 收集、日志尾巴、`terminate()` 而不是 kill pid
- 端口被占 → 拒绝启动且**一个进程都不 spawn**
- 登记表：写入、重载（且全部是 stopped）、删除

Client 半边按页面加载的方式在 `node:vm` 求值，迷你 hooks 运行时把面板渲染出来：空状态、行、点「启动」发到 `/api/localhost.start`、「打开」只在运行中出现、展开后有目录/入口/会话。

## 9. M2 候选（不在这一版）

- `observed` + 扫描 + 收养（明确的语义，不是猜）
- tailnet 地址一列（和 tailscale 插件联动）
- `dsh localhost` CLI（给脚本和人类，和工具共用登记表）
- 自动重启上次在跑的（要用户显式打开，默认关）


## 10. 两次自己撞的墙（v0.1.2）

两件事都是"能测却没测"的典型，记下来，因为它们的形状会重复。

### 10.1 补丁少了一层 `insert:`

`cordis.patch.yml` 里写

```yaml
- id: localhost
  name: dsh-plugin-localhost
```

在 Loader 的批量方言里这是**补丁**（对已存在条目的覆盖），不是新增。id 还不存在就没有东西可补，profile 于是记成 `overrides: ["localhost"]`，bundle 组合出零行。表现是：插件装了、`package.json` 里有、`node_modules` 里也在，**但什么都没发生**——没有面板，没有工具。

诊断靠 `list_bundles` 的两个字段：`rows` 为空而 `overrides` 里有它。

### 10.2 工具定义写成了"参数规格"方言

`ctx.tools.register()` 收的是**成品 ToolDefinition**：`parameters` 与 `output.schema` 都是 JSON Schema。而 `defineTool()`（官方工具包用的那个）收的是另一种"参数规格"方言——`required: true` 写在字段里，由它转换成 JSON Schema。

我把规格方言直接交给了 `register`，`assertSupportedJsonSchema` 抛错。Cordis 的 fiber 失败会**回滚整个 apply**，于是先注册的路由一起被撤掉。表现是：面板能渲染（客户端半边独立），但数据请求 404。

这两条现在都有测试守着：补丁形状（`- insert:`、无裸行）、工具定义（只允许支持的 JSON Schema 关键词、`required` 必须是数组）。

### 10.3 还有一条：文字淡到看不见

`--dsw-alias-label-dimmed` 在 cream 主题里是 `mix(canvas, ink, 0.125)`——12.5% 的墨，对比度约 1.2:1。它是**占位符/骨架**用的，不是正文。把副标题、页脚、空状态都用了它，屏幕上等于没字。

改用 `label-tertiary`（3.76:1，元信息）与 `label-secondary`（5.85:1，正文），并加了一条测试：面板 CSS 里不许出现 `label-dimmed`。

## 11. 打开的是根路径，不是页面（v0.1.3）

登记表里第一件真实的东西是 `kibellah-radio`：`python3 serve.py station --port $PORT`，服务好得很——`/the-way-back/index.html` 返回 200、Range 请求返回 206。但面板上的「打开」打开的是 `http://127.0.0.1:8840/`，那个服务器没有根路由，于是 404。

**根因是模型错了，不是按钮错了。** 一个被托管的服务，"地址"不等于"它的根"。所以：

- 登记项多一个 `path`（URL 路径），`url` = 端口 + path；`Serve` 的 `path` 参数写清楚了"只在它真的服务根路径时才省略"；
- 面板详情多一行「打开地址」，把按钮会去的完整 URL 写出来——以后再有类似情况，一眼能看出它要去哪。

同时修了两个连带问题：

1. **工具输出被自己的 schema 拒收。** `view()` 返回 `entry`/`pid`/`startedAt` 等字段，而 schema 只声明了子集，`additionalProperties: false` 于是报 `"value.services[0].entry" is not a declared property`——服务起来了，结果吐不出来。现在字段表是**一份数据**（`FIELD_TYPES`），`view()` 和 schema 都从它派生，测试对比两边。
2. **登记会话永远是空的。** 我编了一个 `context.__agent`，真实字段是 `exec.agent`。所以那条 `kibellah-radio` 的 `sessionId` 是空字符串。
3. **重复登记会占第二个端口。** 同一个目录同一条命令再登记一次，现在是**更新**（补 `path`、改名字），不是新增。忘了 `path` 的 agent 因此不需要"删掉重来"——那会把一个正在工作的服务杀掉。
