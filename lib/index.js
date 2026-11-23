/**
 * present_document 宿主侧：注册一个只收 Markdown 的工具，并把它推进本机回环 HTTP 服务。
 * 文档按「调用方会话」分桶保存：浏览器侧（lib/client.js）轮询时带上自己的会话 id，
 * 只取回本会话那一份，于是推送不会串到用户正在看的别的会话里。
 * 这里不经 userQuestions，因此不产生任何审批弹框。
 */
import { createServer } from 'node:http'

/** Cordis 插件名；与包名、加载器行 id 同为 dsh-present-document。 */
export const name = 'dsh-present-document'

/** 依赖的工具注册表。 */
export const inject = ['tools']

/** 浏览器侧与宿主侧约定好的回环端口；环境变量只给本机自测换到空闲端口用（浏览器侧仍写死 17771）。 */
const PORT = Number(process.env.DSH_PRESENT_DOCUMENT_PORT ?? '') || 17771

/** 最多保留多少个会话的文档；超出按最久未呈交淘汰。 */
const MAX_SESSIONS = 24

/** 某个会话还没有文档时的响应：at = 0 表示「没有」，浏览器侧不会据此打开标签页。 */
const EMPTY_PAYLOAD = JSON.stringify({ title: '', markdown: '', at: 0 })

/**
 * 会话 id → 该会话最近一份文档的响应体（已序列化，轮询不再重复序列化正文）。
 * 新旧由响应体里的 at 表达：浏览器侧只按 at 判断，宿主实例重建也不会让浏览器错判。
 * 只收有会话身份的文档，空会话 id 不占名额。
 */
const documents = new Map()

/** 全局最新一份文档 { at, payload }；没有任何呈交时是空文档，只给不带 session 参数的自检请求用。 */
let newest = { at: 0, payload: EMPTY_PAYLOAD }

/** 跨会话共用的单调版本戳：每份文档的 at 唯一且只增。 */
let lastAt = 0

/** 当前在监听的回环服务；null 表示没有可用实例。 */
let server = null

/** 正在启动中的那次启动；并发调用共用它，避免抢同一个端口。 */
let starting = null

/**
 * 只放行本机自身的页面源，避免任意网页跨源读走文档正文：
 * 回环 http 源（浏览器里打开的 Web GUI），以及桌面端的 dsh-app: 协议源（桌面窗口的页面源）。
 */
function isTrustedOrigin(origin) {
  if (typeof origin !== 'string' || origin === '') return false
  try {
    const { hostname, protocol } = new URL(origin)
    if (protocol === 'dsh-app:') return true
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]'
  } catch {
    return false
  }
}

/**
 * 工具调用归属的会话 id：宿主在 exec.agent 上给出调用方 Agent，Agent.session.id 即会话 id。
 * 拿不到（没有 agent 的调用）时落到空键，只能由不带 session 参数的 /latest 看到，不推给任何会话。
 */
function sessionKeyOf(exec) {
  const id = exec?.agent?.session?.id
  return typeof id === 'string' && id !== '' ? id : ''
}

/** 记住一份文档：更新全局最新，并写入该会话的桶、维持会话数上限。 */
function remember(session, doc) {
  const payload = JSON.stringify(doc)
  if (doc.at > newest.at) newest = { at: doc.at, payload }
  // 没有会话身份的调用只更新全局最新（自检可见），不占用会话名额。
  if (session === '') return
  documents.delete(session)
  documents.set(session, payload)
  while (documents.size > MAX_SESSIONS) {
    const oldest = documents.keys().next()
    if (oldest.done) break
    documents.delete(oldest.value)
  }
}

/** 处理一次回环请求；解析异常绝不能逸出请求监听器——那会以未捕获异常终止宿主进程。 */
function handleRequest(req, res) {
  try {
    respond(req, res)
  } catch (error) {
    console.error('[dsh-present-document] 回环请求处理异常：' + String(error && error.message))
    if (!res.headersSent) res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
    if (!res.writableEnded) res.end('{"error":"bad request"}')
  }
}

/** 应答 GET /latest：带 session 参数返回该会话的文档，不带则返回全局最新一份。 */
function respond(req, res) {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  if (url.pathname !== '/latest') {
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end('{"error":"not found"}')
    return
  }
  const headers = {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    vary: 'origin',
  }
  if (isTrustedOrigin(req.headers.origin)) headers['access-control-allow-origin'] = req.headers.origin
  res.writeHead(200, headers)
  const session = url.searchParams.get('session')
  if (session === null) {
    res.end(newest.payload)
    return
  }
  // 空会话 id 从不登记（见 remember），自然按「没有文档」应答。
  const entry = documents.get(session)
  res.end(entry === undefined ? EMPTY_PAYLOAD : entry)
}

/** 新建并监听回环服务；返回是否真的在监听（端口被占用时为 false）。 */
async function startServer() {
  const instance = createServer(handleRequest)
  server = instance
  instance.on('error', (error) => {
    console.error('[dsh-present-document] 回环服务不可用：' + String(error && error.message))
  })
  const started = await new Promise((resolve) => {
    instance.once('listening', () => resolve(true))
    instance.once('error', () => resolve(false))
    instance.listen(PORT, '127.0.0.1')
  })
  if (!started || server !== instance) {
    if (instance.listening) instance.close()
    if (server === instance) server = null
    return false
  }
  return true
}

/** 确保回环服务可用；可用即复用，未监听就起一次。 */
async function ensureServer() {
  if (server !== null && server.listening) return true
  if (starting === null) {
    starting = startServer().finally(() => {
      starting = null
    })
  }
  return starting
}

/** 关闭回环服务，释放端口。 */
function stopServer() {
  const instance = server
  server = null
  if (instance !== null && instance.listening) instance.close()
}

/** 模型侧工具定义：只做展示，不改任何文件。 */
const tool = {
  name: 'present_document',
  description:
    '把一份 Markdown 文档交给 Web GUI 的右侧侧边栏自动打开（只读展示，不弹审批、不产生任何交互按钮）。'
    + ' 用于审查报告这类需要独立阅读的文档：正文整体放进 markdown 参数，调用一次即送达。'
    + ' 内容只在发起这次调用的那个会话的浏览器界面呈现，不落盘。',
  parameters: {
    title: {
      type: 'string',
      description: '标签页标题，简短；缺省用「文档」。',
    },
    markdown: {
      type: 'string',
      required: true,
      description: '完整 Markdown 正文。调用一次呈交一份文档；同一会话再次调用覆盖同一标签页。',
    },
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        delivered: { type: 'boolean' },
        title: { type: 'string' },
        length: { type: 'integer' },
        session: { type: 'boolean' },
      },
      required: ['delivered', 'title'],
    },
    render: (_args, value) => [{
      type: 'text',
      text: (value.delivered === false ? '已写入内存但回环服务不可用（端口被占用）：' : '已呈交到右侧侧边栏：')
        + value.title + '（' + String(value.length ?? 0) + ' 字符）'
        + (value.session === false ? '；但本次调用拿不到会话 id，浏览器侧不会显示' : ''),
    }],
  },
  async execute(args, exec) {
    const markdown = typeof args?.markdown === 'string' ? args.markdown : ''
    const title = typeof args?.title === 'string' && args.title.trim() !== '' ? args.title.trim() : '文档'
    const session = sessionKeyOf(exec)
    lastAt = Math.max(Date.now(), lastAt + 1)
    remember(session, { title, markdown, at: lastAt })
    const delivered = await ensureServer()
    return { delivered, title, length: markdown.length, session: session !== '' }
  },
}

/**
 * 挂载插件。
 * @param ctx - 带 tools 的宿主上下文。
 */
export function apply(ctx) {
  ctx.effect(() => {
    const dispose = ctx.tools.register(tool)
    return () => {
      try {
        dispose()
      } catch (error) {
        console.error('[dsh-present-document] 工具注销失败：' + String(error && error.message))
      }
    }
  }, 'dsh-present-document: tool')

  ctx.effect(() => {
    ensureServer().catch((error) => {
      console.error('[dsh-present-document] 回环服务启动异常：' + String(error && error.message))
    })
    return () => stopServer()
  }, 'dsh-present-document: loopback server')
}
