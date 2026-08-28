import WebSocket from 'ws'
import { request, type IncomingHttpHeaders } from 'node:http'

const hopByHopHeaders = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'])
type PendingWebSocketFrame = { data: Buffer; binary: boolean }
const localWebSockets = new Map<string, { socket: WebSocket; pending: PendingWebSocketFrame[] }>()

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
  socket.send(JSON.stringify({id,status:502,headers:{'content-type':'text/plain'},body:Buffer.from('local service unavailable').toString('base64')}))
}

function localWebSocketHeaders(headers: IncomingHttpHeaders | undefined): IncomingHttpHeaders {
  const forwarded = localRequestHeaders(headers, new URL('http://localhost'), 0)
  for (const name of ['host', 'content-length', 'sec-websocket-extensions', 'sec-websocket-key', 'sec-websocket-protocol', 'sec-websocket-version']) delete forwarded[name]
  return forwarded
}

function localWebSocketUrl(path: string, target: string) {
  const url = new URL(path || '/', target)
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
    const local = new WebSocket(localWebSocketUrl(message.path, target), protocols, {
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
const connect = () => {
  const socket = new WebSocket(`${relay}?tunnel=${encodeURIComponent(tunnel)}&token=${encodeURIComponent(token)}`)
  socket.on('open', () => console.log(`[agent] ${tunnel} connected -> ${target}`))
  socket.on('message', (raw) => {
    try {
      const message = JSON.parse(raw.toString())
      if (String(message.type || '').startsWith('ws-')) {
        handleWebSocketMessage(socket, message, target)
        return
      }
      const url = new URL(message.path || '/', target)
      const body = Buffer.from(message.body || '', 'base64')
      const req = request(url, { method:message.method, headers:localRequestHeaders(message.headers, url, body.length) }, (response) => {
        const chunks:Buffer[]=[]
        response.on('data',(chunk)=>chunks.push(chunk))
        response.on('end',()=>socket.send(JSON.stringify({id:message.id,status:response.statusCode,headers:response.headers,body:Buffer.concat(chunks).toString('base64')})))
      })
      req.on('error',()=>sendFailure(socket, message.id))
      req.end(body)
    } catch {
      sendFailure(socket, undefined)
    }
  })
  socket.on('close', () => {
    for (const local of localWebSockets.values()) local.socket.close()
    localWebSockets.clear()
    setTimeout(connect, 1500)
  }); socket.on('error', () => socket.close())
}
connect()
