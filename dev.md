# 开发说明

面向修改本插件的人。安装与使用见 [README.md](README.md)。

## 目录结构

| 路径 | 作用 |
| --- | --- |
| `lib/index.js` | 宿主侧：注册 `present_document` 工具，并在 `127.0.0.1` 的候选窗口（17771–17780）里第一个能监听的端口上起只读回环服务（`GET /latest?session=<会话 id>`） |
| `lib/client.js` | 浏览器侧：右栏标签页 `dsh-present-document`，轮询宿主并渲染 Markdown |
| `cordis.patch.yml` | 作为 bundle 的补丁层，把插件行插入 Web 插件名册（一行同时挂宿主侧与浏览器侧） |
| `package.json` | `dsh.bundle.patch` / `dsh.client` / `dsh.engines` 等装载声明 |

## 机制与约束

- 文档按**调用方会话**分桶：宿主从 `exec.agent.session.id` 取会话 id 当桶键，每个会话只保留自己那份。
- 回环接口：`GET /latest?session=<会话 id>` 返回该会话最近一份文档 `{ title, markdown, at, plugin, started }`（该会话还没有文档时是 `{ title: '', markdown: '', at: 0, plugin, started }`）；`GET /latest`（不带参数）返回全局最新一份，只给自检用。`plugin` 是固定身份标记 `dsh-present-document`，`started` 是本宿主进程的模块加载时刻——浏览器侧用这两个字段确认「这个端口上跑的就是本插件」并挑出最新的那个实例。
- 浏览器侧每 2500ms 轮询（页面不可见时不轮询），带上当前查看的会话 id（`ctx.uiSession.adapter.current` 的 `key`）；取不到会话 id 就跳过本轮——宁可不推，也不把文档串到别的会话。切换会话时立刻补一次轮询。
- `at` 是跨会话共用的单调时间戳；某会话的文档 `at` 比它上次推过的更新时，才在**该会话**的右栏自动打开标签页，所以别的会话推来的文档不会弹到用户正在看的会话里。
- 取不到会话 id 的调用（`exec.agent` 缺失）落空键，谁都读不到，只有不带参数的 `/latest` 能看到——这是唯一的降级路径。
- 端口被占用时：宿主按候选窗口顺序自动顺延（17771 → 17772 → … → 17780），监听成功的那一个端口会写进宿主日志与工具返回值（`port` 字段）；只有**整窗都被占用**才返回 `delivered: false`，此时文档只在宿主内存里，右栏会显示「未连上宿主回环服务」的显式提示。
- 插件被禁用 / 移除时关闭该服务并释放端口，不留后台监听。
- 文档只存在宿主内存，**不落盘**；桌面端重启后需要重新调用一次。
- 渲染口径（`lib/client.js` 的 `renderMarkdown`）：有序列表按**作者写的序号**渲染（`<ol start>` + `<li value>`），所以「严重 1–3 → 待定 4–6」这类跨段连续编号不会被重排成 1、2、3；同一项下缩进 2 空格以上的续行（问题 / 拟改动 / 判定依据…）作为该项正文另起一行，不占新序号；比首项更深一层的子列表也按续行文本处理（`· ` 前缀），不参与顶层编号。
- 每个会话只保留**最近一份**文档；最多同时保留 24 个会话的文档，超出按最久未呈交淘汰。
- 宿主侧只绑 `127.0.0.1`，且只对本机自身的页面源回显 CORS 头：回环 http 源（`127.0.0.1` / `localhost` / `[::1]`，浏览器里打开的 Web GUI）与桌面端的 `dsh-app:` 协议源（桌面窗口的页面源是 `dsh-app://app`）；其它网页读不到。本机其它进程仍可直接访问该端口（无鉴权，内容是文档正文，不含凭证）。

## 端口契约（改端口必读）

| 常量 | 值 | 出现位置 |
| --- | --- | --- |
| `PLUGIN_ID` | `dsh-present-document` | `lib/index.js`（应答身份）、`lib/client.js`（只认这个身份） |
| `PORT_BASE` | `17771` | 两个文件都有，必须一致 |
| `PORT_WINDOW` | `10` | 两个文件都有，必须一致（候选 17771–17780） |

- **为什么要有窗口**：浏览器侧读不到宿主的环境变量，只能探测一张两端都写死的候选表。窗口是这条通道的物理边界，不是随手取的数。
- **`DSH_PRESENT_DOCUMENT_PORT` 只在窗口内生效**：给出窗口内的值时，宿主优先试它，其余按窗口顺序补齐；给出窗口外或非法的值时，宿主**告警一次并忽略**，改用窗口内端口。这样"设了环境变量却两侧互不相认"这条静默错位路径不存在——要么一致，要么在日志里明说被忽略。
- **浏览器侧选择规则**（`discover`）：并行探满整窗，只接受身份标记匹配的应答（旧宿主缺该字段时，仅窗口起点 17771 上的应答被接受）；先按「带身份标记」优先，再按 `started` 最新，最后平手取端口小者。因此端口上残留的旧实例不会被误认。
- **兼容退化**：旧宿主没有 `plugin` 字段时，只有 17771（它唯一的固定端口）上的应答被接受，等同于老行为；缺 `started` 时按 0 排序，平手取端口小者。旧浏览器对新宿主多出来的字段无感。
- **多实例边界**：同一台机器上跑着多个 DSH 实例时，浏览器只连 `started` 最新（即最新启动）的那一个；另一个实例发起的会话文档在本页面看不到。这是这条探测通道的已知边界，不假装成「连上了但没文档」。
- **改端口就是改两个文件**：`lib/index.js` 与 `lib/client.js` 的 `PORT_BASE`/`PORT_WINDOW` 必须同时改，否则回到静默错位。改完按下面「改动前自检」逐条验证。

## 命名口径

| 名字 | 用在哪 |
| --- | --- |
| `dsh-present-document` | npm 包名 / bundle 名 / 浏览器模块 id / 插件行 id（entryId `include:dsh-present-document`）/ 标签页 id 与 kind / 日志前缀 |
| `present_document` | 模型工具名；工具注册表用下划线，属独立命名空间，不带前缀 |

## 生效方式

- `lib/client.js` 改动需重启桌面端：Web 插件名册在启动时扫描生成。
- `cordis.patch.yml` / `package.json` 里的装载声明改动同样需要重启。
- 禁用 / 移除插件时宿主侧会关闭回环服务并释放它实际监听的候选端口（监听代际计数保证进行中的启动也会立刻作废，不留后台监听）。

## 装载踩坑（实测记录）

1. 工具的 `output` 必须同时有 `schema` 与 `render(args, value)`，缺一个就报 `must declare output { schema, render, presentationMeta? }`。
2. `output.schema` 是标准 JSON Schema：**属性里不能写 `required: true`**，要用对象级 `required: [...]`；而工具的 `parameters` 用的是逐属性 `required: true` 的方言，两者不一样。

## 兼容性

- `dsh.engines.dsh` 声明为 `>=0.2.2-rc.2`（按 0.2.2-rc.5 实测）。
- 客户端用到的宿主面：`ctx.sidebarRightTabs.register`、`ctx.slots.inject` + `ctx.slots.register`、`ctx.sidebarRight.openTab`、`ctx.effect`，以及 `ctx.uiSession.adapter.current` 的 `getSnapshot().key` 与 `subscribe`。前四个是公开面；`uiSession.adapter.current` 是唯一需要留意的半私有面——宿主调整会话状态结构时会先破这一处。

## 版本管理

- 语义化版本写在 `package.json` 的 `version`；发版打 tag（`v0.1.0`），安装端可用 `#v0.1.0` 锁定。
- 本仓库**无构建步骤**：`lib/` 里的 JS 就是发布内容，提交即可安装。
- `package.json` 的 `files` 白名单决定装进安装端的内容（`lib/`、`cordis.patch.yml`、`README.md`、`dev.md`、`LICENSE`），新增文件记得加进去。

## 改动前自检

- 宿主侧：先看宿主日志里的「回环服务已监听 127.0.0.1:<端口>」，再取 `http://127.0.0.1:<端口>/latest?session=<会话 id>`，应返回 `{ title, markdown, at, plugin, started }` 形态的 JSON；换一个没呈交过的会话 id 应返回空文档（`at: 0`，但 `plugin`/`started` 仍在）；每调用一次 `present_document`，该会话的 `at` 必须变大（只看“能返回 JSON”不够，旧实例也能返回）。
- 顺延自检：先用任意进程占住当前端口（或直接让真实实例跑着），再调用一次，工具返回值里的 `port` 必须换到窗口内下一个空闲端口，右栏照常显示。
- 环境变量自检：`DSH_PRESENT_DOCUMENT_PORT=17775` 应监听 17775 且无告警；`=20000` 或 `=abc` 应有一条「已忽略 DSH_PRESENT_DOCUMENT_PORT=…」告警并改用窗口内端口。
- 释放：禁用插件后 `Test-NetConnection 127.0.0.1 -Port <该次端口>` 应失败、端口不再监听；整窗都应回到空闲。
- 坏路径自检：整窗被占满时应返回 `delivered: false` 且不含 `port` 字段，右栏面板显示「未连上宿主回环服务（已试 127.0.0.1:17771–17780）」。
- 浏览器侧：在会话 A 调用后，只有会话 A 的右栏自动打开；切到会话 B 不应看到这份文档，在会话 B 调用则只出现在 B，再次调用覆盖同一标签页而不是新建。
