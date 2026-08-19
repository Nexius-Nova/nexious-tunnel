import WebSocket from 'ws'
import { request } from 'node:http'
const args = Object.fromEntries(process.argv.slice(2).reduce<string[][]>((all, value, index, list) => value.startsWith('--') ? [...all, [value.slice(2), list[index + 1] || '']] : all, []))
const relay = args.relay, tunnel = args.tunnel, token = args.token, target = args.target
if (!relay || !tunnel || !token || !target) { console.error('用法: pnpm --filter @nexious/agent start -- --relay ws://host/relay --tunnel tun-id --token TOKEN --target http://127.0.0.1:8080'); process.exit(1) }
const connect = () => {
  const socket = new WebSocket(`${relay}?tunnel=${encodeURIComponent(tunnel)}&token=${encodeURIComponent(token)}`)
  socket.on('open', () => console.log(`[agent] ${tunnel} connected -> ${target}`))
  socket.on('message', (raw) => { const message = JSON.parse(raw.toString()); const url = new URL(message.path || '/', target); const body = Buffer.from(message.body || '', 'base64'); const req = request(url, { method:message.method, headers:{...message.headers, host:url.host, 'content-length':body.length} }, (response) => { const chunks:Buffer[]=[]; response.on('data',(chunk)=>chunks.push(chunk)); response.on('end',()=>socket.send(JSON.stringify({id:message.id,status:response.statusCode,headers:response.headers,body:Buffer.concat(chunks).toString('base64')}))) }); req.on('error',()=>socket.send(JSON.stringify({id:message.id,status:502,headers:{'content-type':'text/plain'},body:Buffer.from('local service unavailable').toString('base64')}))); req.end(body) })
  socket.on('close', () => setTimeout(connect, 1500)); socket.on('error', () => socket.close())
}
connect()
