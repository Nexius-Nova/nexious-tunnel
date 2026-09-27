import WebSocket from 'ws'
import { request, type IncomingHttpHeaders } from 'node:http'

const hopByHopHeaders = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'])
type PendingWebSocketFrame = { data: Buffer; binary: boolean }
const localWebSockets = new Map<string, { socket: WebSocket; pending: PendingWebSocketFrame[] }>()

// 转发路径必须是以单个 / 开头的站点内路径。像 `//evil.example/x`、`/\evil.example` 这类值会被
// URL 解析器当作「更换主机」，从而让公网请求绕过隧道绑定的本地目标，访问本机任意端口/内网/公网。
function safeForwardPath(value: unknown): string | null {
  const raw = typeof value === 'string' && value ? value : '/'
  if (!raw.startsWith('/') || raw.startsWith('//')) return null
  if (raw.includes('\\') || /[\u0000-\u001f\u007f]/.test(raw)) return null
  return raw
}

function localRequestHeaders(headers: IncomingHttpHeaders | undefined, url: URL, bodyLength: number): IncomingHttpHeaders {
  const forwarded: IncomingHttpHeaders = {}
  for (const [key, value] of Object.entries(headers || {})) {
    const normalizedKey = key.toLowerCase()
    if (value === undefined || hopByHopHeaders.has(normalizedKey) || normalizedKey === 'host' || normalizedKey === 'content-length') continue
    forwarded[key] = value
  }
  forwarded.host = url.host
  forwarded['content-length'] = String(bodyLength)
  return forwarded
}

function sendFailure(socket: WebSocket, id: unknown) {
  if (!id) return
  socket.send(JSON.stringify({id,status:502,headers:{'content-type':'text/plain'},body:Buffer.from('local service unavailable').toString('base64')}))
}

// 响应体整包缓冲后经 base64+JSON 转发，限制上限避免大文件打爆内存。
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024

function localWebSocketHeaders(headers: IncomingHttpHeaders | undefined): IncomingHttpHeaders {
  const forwarded = localRequestHeaders(headers, new URL('http://localhost'), 0)
  for (const name of ['host', 'content-length', 'sec-websocket-extensions', 'sec-websocket-key', 'sec-websocket-protocol', 'sec-websocket-version']) delete forwarded[name]
  return forwarded
}

function localWebSocketUrl(path: string, target: string) {
  const safe = safeForwardPath(path)
  if (!safe) throw new Error('unsafe forward path')
  const url = new URL(safe, target)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return url
}

function handleWebSocketMessage(relaySocket: WebSocket, message: any, target: string) {
  const id = String(message.id || '')
  if (!id) return
  if (message.type === 'ws-open') {
    localWebSockets.get(id)?.socket.close()
    const protocolValue = message.headers?.['sec-websocket-protocol']
    const protocols = (Array.isArray(protocolValue) ? protocolValue : String(protocolValue || '').split(','))
      .map((value: string) => value.trim()).filter(Boolean)
    let localUrl: URL
    try {
      localUrl = localWebSocketUrl(message.path, target)
    } catch {
      if (relaySocket.readyState === WebSocket.OPEN) relaySocket.send(JSON.stringify({type:'ws-close',id,code:1011,reason:'unsafe forward path'}))
      return
    }
    const local = new WebSocket(localUrl, protocols, {
      headers: localWebSocketHeaders(message.headers)
    })
    const state = { socket: local, pending: [] as PendingWebSocketFrame[] }
    localWebSockets.set(id, state)
    local.on('open', () => {
      for (const frame of state.pending.splice(0)) local.send(frame.data, {binary:frame.binary})
    })
    local.on('message', (data, isBinary) => {
      if (relaySocket.readyState === WebSocket.OPEN) relaySocket.send(JSON.stringify({type:'ws-data',id,binary:isBinary,data:Buffer.from(data as Buffer).toString('base64')}))
    })
    local.on('close', (code, reason) => {
      localWebSockets.delete(id)
      if (relaySocket.readyState === WebSocket.OPEN) relaySocket.send(JSON.stringify({type:'ws-close',id,code,reason:reason.toString()}))
    })
    local.on('error', () => local.close())
  } else if (message.type === 'ws-data') {
    const state = localWebSockets.get(id)
    if (!state) return
    const frame = {data:Buffer.from(message.data || '', 'base64'),binary:Boolean(message.binary)}
    if (state.socket.readyState === WebSocket.OPEN) state.socket.send(frame.data, {binary:frame.binary})
    else if (state.socket.readyState === WebSocket.CONNECTING) state.pending.push(frame)
  } else if (message.type === 'ws-close') {
    localWebSockets.get(id)?.socket.close(Number(message.code) || 1000, String(message.reason || ''))
    localWebSockets.delete(id)
  }
}

const args = Object.fromEntries(process.argv.slice(2).reduce<string[][]>((all, value, index, list) => value.startsWith('--') ? [...all, [value.slice(2), list[index + 1] || '']] : all, []))
const relay = args.relay, tunnel = args.tunnel, token = args.token, target = args.target
if (!relay || !tunnel || !token || !target) { console.error('用法: pnpm --filter @nexious/agent start -- --relay ws://host/relay --tunnel tun-id --token TOKEN --target http://127.0.0.1:8080'); process.exit(1) }
// 指数退避：网络抖动时快速重连（1.5s 起），持续失败则逐步拉长到 30s 上限，
// 避免固定 1.5s 轮询在服务端长时间不可用时刷爆日志与对端连接数。
const RECONNECT_BASE_MS = 1500, RECONNECT_MAX_MS = 30_000;
let reconnectDelay = RECONNECT_BASE_MS;
const connect = () => {
  // token 只通过 Authorization 头传递，不再放进 URL：URL 会被中间代理的访问日志记录，
  // 而新版服务端已优先读取请求头，query 参数没有保留价值。
  const socket = new WebSocket(`${relay}?tunnel=${encodeURIComponent(tunnel)}`, {
    headers: { authorization: `Bearer ${token}` }
  })
  socket.on('open', () => { reconnectDelay = RECONNECT_BASE_MS; console.log(`[agent] ${tunnel} connected -> ${target}`) })
  socket.on('message', (raw) => {
    try {
      const message = JSON.parse(raw.toString())
      if (String(message.type || '').startsWith('ws-')) {
        handleWebSocketMessage(socket, message, target)
        return
      }
      const forwardPath = safeForwardPath(message.path)
      if (!forwardPath) {
        sendFailure(socket, message.id)
        return
      }
      const url = new URL(forwardPath, target)
      const body = Buffer.from(message.body || '', 'base64')
      const req = request(url, { method:message.method, headers:localRequestHeaders(message.headers, url, body.length) }, (response) => {
        const chunks:Buffer[]=[]
        let received = 0
        let oversized = false
        response.on('data',(chunk)=>{
          if (oversized) return
          received += chunk.length
          if (received > MAX_RESPONSE_BYTES) {
            oversized = true
            response.destroy()
            socket.send(JSON.stringify({id:message.id,status:413,headers:{'content-type':'text/plain'},body:Buffer.from('tunnel response exceeds size limit').toString('base64')}))
            return
          }
          chunks.push(chunk)
        })
        response.on('end',()=>{
          if (oversized) return
          socket.send(JSON.stringify({id:message.id,status:response.statusCode,headers:response.headers,body:Buffer.concat(chunks).toString('base64')}))
        })
        response.on('aborted',()=>sendFailure(socket, message.id))
      })
      req.on('error',()=>sendFailure(socket, message.id))
      req.end(body)
    } catch (error) {
      console.error('[agent] 消息处理失败', error)
      sendFailure(socket, undefined)
    }
  })
  socket.on('close', (code) => {
    for (const local of localWebSockets.values()) local.socket.close()
    localWebSockets.clear()
    // 1008 = 凭据无效/隧道被删除，或已被更新的 agent 连接接管。
    // 两种情况重试都无意义：前者永远失败，后者会与现役连接互相顶替形成抖动，直接退出。
    if (code === 1008) { console.error(`[agent] ${tunnel} 被服务端拒绝（code 1008），请重新获取启动命令`); process.exit(1); }
    const delay = reconnectDelay;
    reconnectDelay = Math.min(RECONNECT_MAX_MS, delay * 2);
    setTimeout(connect, delay);
  }); socket.on('error', () => socket.close())
}
connect()
