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

/** 应答里的身份标记：浏览器侧据此确认某个候选端口上跑的是本插件，而不是别的程序。 */
const PLUGIN_ID = 'dsh-present-document'

/** 候选端口窗口起点；浏览器侧 lib/client.js 里有同名常量，两边必须一致。 */
const PORT_BASE = 17771

/** 候选端口窗口大小：17771–17780，被占用时按窗口顺序顺延。 */
const PORT_WINDOW = 10

/** 窗口末端口：日志与提示文案统一用它表达区间。 */
const PORT_LAST = PORT_BASE + PORT_WINDOW - 1

/** 区间文案；出现在日志、工具输出与浏览器侧提示里。 */
const PORT_RANGE = PORT_BASE + '–' + PORT_LAST

/** 本进程的模块加载时刻：浏览器侧用它在多个候选实例里挑最新启动的那一个。 */
const STARTED_AT = Date.now()

/** 最多保留多少个会话的文档；超出按最久未呈交淘汰。 */
const MAX_SESSIONS = 24

/** 某个会话还没有文档时的响应：at = 0 表示「没有」，浏览器侧不会据此打开标签页；plugin / started 供浏览器侧确认身份与实例新旧。 */
const EMPTY_PAYLOAD = JSON.stringify({ title: '', markdown: '', at: 0, plugin: PLUGIN_ID, started: STARTED_AT })

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

/** 当前实际监听的端口；null 表示未监听。 */
let activePort = null

/** 正在启动中的那次启动；并发调用共用它，避免抢同一个端口。 */
let starting = null

/** 监听代际：停止服务会自增它，使进行中的启动作废，卸载后不留后台监听。 */
let generation = 0

/** 环境变量端口被忽略时只告警一次，别每次启动都刷一条。 */
let envPortWarned = false

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
  const payload = JSON.stringify({ ...doc, plugin: PLUGIN_ID, started: STARTED_AT })
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

/** 读环境变量里的端口：落在窗口内时 value 为数值，缺省 / 非法 / 窗口外为 null；raw 留着做告警文案。 */
function envPort() {
  const raw = process.env.DSH_PRESENT_DOCUMENT_PORT
  if (raw === undefined || raw.trim() === '') return { raw: '', value: null }
  const value = Number(raw)
  const inside = Number.isInteger(value) && value >= PORT_BASE && value <= PORT_LAST
  return { raw, value: inside ? value : null }
}

/** 首选端口：环境变量落在窗口内就用它，否则用窗口起点；只取值不告警（挂载期诊断日志用）。 */
function preferredPort() {
  return envPort().value ?? PORT_BASE
}

/** 本次要依次尝试的端口：环境变量指定值优先，其余按窗口顺序；窗口外的值告警一次后忽略。 */
function portCandidates() {
  const windowed = Array.from({ length: PORT_WINDOW }, (_unused, index) => PORT_BASE + index)
  const { raw, value } = envPort()
  if (raw === '') return windowed
  if (value === null) {
    if (!envPortWarned) {
      envPortWarned = true
      console.error(
        '[dsh-present-document] 已忽略 DSH_PRESENT_DOCUMENT_PORT=' + raw
        + '：浏览器侧只探测 ' + PORT_RANGE + '，窗口外的值会让两侧静默错位；本次改用窗口内端口。',
      )
    }
    return windowed
  }
  return [value, ...windowed.filter((port) => port !== value)]
}

/** 新建并监听回环服务：按候选端口顺序试，第一个能监听的就用它；全被占用返回 false。 */
async function startServer() {
  const ticket = generation
  for (const port of portCandidates()) {
    const instance = createServer(handleRequest)
    const listening = await new Promise((resolve) => {
      const settle = (ok) => {
        instance.off('listening', onListening)
        instance.off('error', onError)
        resolve(ok)
      }
      const onListening = () => settle(true)
      const onError = () => settle(false)
      instance.once('listening', onListening)
      instance.once('error', onError)
      instance.listen(port, '127.0.0.1')
    })
    if (!listening) {
      // 本候选被占用或无权限：临时监听器已由 settle 摘净、实例未在监听，直接换下一个候选。
      continue
    }
    // 启动途中插件已被卸载：立刻关掉，不留后台监听。
    if (ticket !== generation) {
      instance.close()
      return false
    }
    instance.on('error', (error) => {
      console.error('[dsh-present-document] 回环服务不可用：' + String(error && error.message))
    })
    server = instance
    activePort = port
    console.log('[dsh-present-document] 回环服务已监听 127.0.0.1:' + port)
    return true
  }
  server = null
  activePort = null
  // 卸载导致的作废不算「端口全被占用」，别误报。
  if (ticket !== generation) return false
  console.error(
    '[dsh-present-document] 回环服务不可用：候选端口 ' + PORT_RANGE
    + ' 全部被占用（或无权监听），文档只在宿主内存里，右栏看不到。',
  )
  return false
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

/** 关闭回环服务，释放端口；并让进行中的启动作废。 */
function stopServer() {
  generation += 1
  const instance = server
  server = null
  activePort = null
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
        port: { type: 'integer' },
      },
      required: ['delivered', 'title'],
    },
    render: (_args, value) => [{
      type: 'text',
      text: (value.delivered === false ? '已写入内存但回环服务不可用：' : '已呈交到右侧侧边栏：')
        + value.title + '（' + String(value.length ?? 0) + ' 字符）'
        + (value.delivered === false || value.port === undefined ? '' : ' · 回环端口 ' + value.port)
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
    return { delivered, title, length: markdown.length, session: session !== '', ...(delivered ? { port: activePort } : {}) }
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
    // 一行诊断：候选窗口与浏览器侧同表；环境变量是否被忽略由启动路径的 portCandidates 告警。
    console.log('[dsh-present-document] 回环候选端口 ' + PORT_RANGE + '（浏览器侧同表），首选 ' + preferredPort())
    ensureServer().catch((error) => {
      console.error('[dsh-present-document] 回环服务启动异常：' + String(error && error.message))
    })
    return () => stopServer()
  }, 'dsh-present-document: loopback server')
}
