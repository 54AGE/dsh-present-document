# dsh-present-document

> DeepSeek Harness（DSH）插件：把一份 Markdown 文档**推到 Web GUI 右侧侧边栏**打开——只读展示
> 任何"正文需要独立阅读、聊天里只留索引"的场合都适用：审查报告、方案对比、长清单、宽表格。

- 宿主侧：模型工具 `present_document({ title, markdown })` + 只读回环服务。
- 浏览器侧：右栏标签页 `dsh-present-document`，轮询宿主、呈交时间戳变新就自动打开并渲染 Markdown（标题、列表、表格、围栏代码、段落）。有序列表按**作者写的序号**渲染（`4.` 就是 `4.`，跨段连续编号不会被重排），列表项下缩进 2 空格以上的续行归入同一条序号、另起一行。
- **按会话隔离**：文档只出现在发起调用的那个会话的右栏；在别的会话里浏览时不会弹出这份文档。
- 零 npm 依赖（只用 Node 内置 `node:http` 与浏览器 `fetch`）；文档不落盘。

## 安装

支持通过 DSH **插件管理器**安装

| 写法 | 说明 |
| --- | --- |
| `github:54AGE/dsh-present-document` | pnpm 的 GitHub 简写，默认取默认分支最新提交 |
| `https://github.com/54AGE/dsh-present-document.git` | 完整 git 地址，等价 |

也可在本机会话里让 agent 执行

`plugin_manager({ action: "install_bundle", target: "github:54AGE/dsh-present-document" })`。

**安装后需重启 DSH 桌面端**

## 使用

模型侧只有一个工具：

```json
{
  "title": "审查结论 · bsms",
  "markdown": "# 范围提示\n…\n## 严重\n1. …\n## 待定\n4. …"
}
```

调用后，立即将这份md文档显示至**发起调用的那个会话**的右侧侧边栏；同一会话再次调用**覆盖同一标签页**（不堆 tab），别的会话看不到它。返回值是 `{ delivered, title, length, session }`；`delivered: false` 表示回环服务不可用（如端口被占用），文档只留在宿主内存里，右栏不会显示。`session: false` 表示这次调用取不到会话 id（没有会话身份的调用），文档不会推到任何会话的右栏。

推荐用法：把需要细读的**完整正文**整体塞进 `markdown`（标题、分节、依据、验证计划都在里面），聊天里只留「N. 文件路径 — 一句话问题」这类索引，用户按序号点开或追问，两侧不重复刷屏。

## 卸载 / 回退

在插件管理器里移除/禁用该插件，重启 DSH 桌面端即可。

## 开发

本机开发同步、机制与约束、装载踩坑、版本管理见 [dev.md](dev.md)。

## License

MIT
