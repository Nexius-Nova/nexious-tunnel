<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { NButton, NModal, NForm, NFormItem, NInput, NInputNumber, NSelect, NSpace, NTooltip, type FormInst, type FormRules } from 'naive-ui'
import { Dices } from 'lucide-vue-next'
import type { NodeInfo, Tunnel, TunnelInput } from '../types'

const props=defineProps<{show:boolean;tunnel:Tunnel|null;nodes:NodeInfo[];tunnels?:Tunnel[];loading:boolean}>()
const emit=defineEmits<{close:[];submit:[value:TunnelInput]}>()
const formRef=ref<FormInst|null>(null)
const form=reactive<TunnelInput>({name:'',protocol:'https',localHost:'127.0.0.1',localPort:3000,remotePort:443,nodeId:'',domain:null})

// 随机子域名由「形容词-名词-随机串」组成，可读、好记，且天然满足服务端子域名校验。
const DOMAIN_HEADS=['swift','lunar','amber','cedar','cobalt','zephyr','nova','ember','onyx','quartz','willow','atlas','prism','raven','sable','drift','lumen','orbit','pixel','solar','misty','vivid','frost','quiet']
const DOMAIN_TAILS=['fox','wave','peak','harbor','loop','mint','ridge','spark','tide','vault','brook','comet','grove','lark','mesa','node','pine','reef','stone','wren','dune','glow','haze','trail']
const pick=(list:string[])=>list[Math.floor(Math.random()*list.length)]
function randomSubdomain(){
  const tail=Math.random().toString(36).slice(2,6).padEnd(4,'0')
  return `${pick(DOMAIN_HEADS)}-${pick(DOMAIN_TAILS)}-${tail}`
}
// 当前节点上已被占用的子域名（排除正在编辑的这条隧道），用于避免生成冲突值。
const takenDomains=computed(()=>new Set((props.tunnels||[]).filter(t=>t.node_id===form.nodeId&&t.id!==props.tunnel?.id&&t.domain).map(t=>String(t.domain).toLowerCase())))
function nextRandomDomain(){
  for(let i=0;i<40;i+=1){const candidate=randomSubdomain();if(!takenDomains.value.has(candidate))return candidate}
  return `${randomSubdomain()}-${Math.random().toString(36).slice(2,5)}`
}
function rollDomain(){form.domain=nextRandomDomain()}
// 粘贴或输入时即时清洗：去掉非法字符，保证域名始终合法。
function onDomainInput(value:string){
  const cleaned=String(value||'').toLowerCase().replace(/[^a-z0-9-]/g,'').replace(/^-+/,'').slice(0,63)
  form.domain=cleaned||null
}

watch(()=>[props.show,props.tunnel] as const,()=>{if(!props.show)return;Object.assign(form,props.tunnel?{name:props.tunnel.name,protocol:props.tunnel.protocol,localHost:props.tunnel.local_host,localPort:props.tunnel.local_port,remotePort:props.tunnel.remote_port,nodeId:props.tunnel.node_id,domain:props.tunnel.domain}:{name:'',protocol:'https',localHost:'127.0.0.1',localPort:3000,remotePort:443,nodeId:props.nodes.find(n=>n.status==='online')?.id||'',domain:null});if(!props.tunnel)form.domain=nextRandomDomain()},{immediate:true})
// 节点列表刷新只用于补齐默认节点，不能重置用户正在填写的表单。
watch(()=>props.nodes,()=>{if(props.show&&!form.nodeId)form.nodeId=props.nodes.find(n=>n.status==='online')?.id||''})
const nodeOptions=computed(()=>props.nodes.map(n=>({label:`${n.name}${n.status!=='online'?'（维护中）':''}`,value:n.id,disabled:n.status!=='online'})))
const accessUrl=computed(()=>{const host=props.nodes.find(n=>n.id===form.nodeId)?.host;return form.domain&&host?`https://${form.domain}.${host}/`:''})
const rules:FormRules={name:{required:true,min:2,message:'请输入至少 2 个字符的名称',trigger:'blur'},localPort:{type:'number',required:true,message:'请输入本地端口',trigger:['blur','change']},nodeId:{required:true,message:'请选择节点',trigger:'change'},domain:{required:true,trigger:['input','blur'],validator:(_rule,value)=>{if(!value)return new Error('请输入访问子域名');if(!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value))return new Error('仅支持小写字母、数字和连字符');if(value==='api'||value==='node')return new Error('api 与 node 为平台保留子域名，请换一个');if(takenDomains.value.has(value))return new Error('该节点上此子域名已被使用，点击骰子换一个');return true}}}
async function submit(){form.domain=form.domain?.trim().toLowerCase()||null;try{await formRef.value?.validate()}catch{return}emit('submit',{...form,domain:form.domain})}
</script>
<template>
  <n-modal :show="show" preset="card" :title="tunnel?'编辑隧道':'创建新隧道'" :style="{ width: 'min(460px, calc(100vw - 32px))' }" :mask-closable="false" @close="emit('close')">
    <div class="modal-intro"><b>{{tunnel?'更新连接参数':'将本地服务安全发布到公网'}}</b><span>配置隧道名称、协议、节点及访问域名。</span></div>
    <n-form ref="formRef" :model="form" :rules="rules" label-placement="top" :disabled="loading">
      <n-form-item label="隧道名称" path="name"><n-input v-model:value="form.name" maxlength="32" placeholder="例如：开发环境 API"/></n-form-item>
      <div class="form-grid">
        <n-form-item label="协议"><n-select v-model:value="form.protocol" :options="['https','http'].map(v=>({label:v.toUpperCase(),value:v}))"/></n-form-item>
        <n-form-item label="边缘节点" path="nodeId"><n-select v-model:value="form.nodeId" :options="nodeOptions"/></n-form-item>
      </div>
      <n-form-item label="本地端口" path="localPort"><n-input-number v-model:value="form.localPort" :min="1" :max="65535" style="width:100%" placeholder="3000"/></n-form-item>
      <n-form-item label="访问子域名" path="domain">
        <div class="domain-field">
          <n-input v-model:value="form.domain" maxlength="63" placeholder="myapp" @update:value="onDomainInput">
            <template #suffix>
              <n-tooltip>
                <template #trigger>
                  <button type="button" class="roll-btn" aria-label="随机生成子域名" title="随机生成子域名" @click="rollDomain"><Dices :size="16"/></button>
                </template>
                随机生成一个可用的子域名
              </n-tooltip>
            </template>
          </n-input>
          <div v-if="accessUrl" class="domain-preview"><span>公网访问地址</span><code>{{accessUrl}}</code></div>
        </div>
      </n-form-item>
    </n-form>
    <template #action>
      <n-space justify="end"><n-button @click="emit('close')">取消</n-button><n-button type="primary" :loading="loading" @click="submit">{{tunnel?'保存修改':'创建隧道'}}</n-button></n-space>
    </template>
  </n-modal>
</template>
<style scoped>
.modal-intro{margin-bottom:16px;display:flex;flex-direction:column;gap:4px}
.modal-intro b{font-size:14px}
.modal-intro span{font-size:12px;color:var(--text-secondary)}
.form-grid{display:grid;grid-template-columns:1fr 1fr;gap:0 16px}
.domain-field{width:100%;min-width:0}
.roll-btn{display:grid;place-items:center;width:26px;height:26px;border:0;border-radius:6px;background:transparent;color:var(--text-secondary);cursor:pointer;transition:color .2s ease,background .2s ease,transform .25s cubic-bezier(.34,1.56,.64,1)}
.roll-btn:hover{color:var(--accent);background:rgba(var(--accent-rgb),.1)}
.roll-btn:active{transform:rotate(-25deg) scale(.9)}
.roll-btn:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
:global(.theme-light) .roll-btn:hover{color:var(--accent);background:rgba(var(--accent-rgb),.1)}
.domain-preview{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:8px;padding:9px 11px;border:1px solid rgba(var(--accent-rgb),.24);border-radius:5px;background:rgba(var(--accent-rgb),.07);overflow:hidden}
.domain-preview span{flex:none;font-size:11px;color:#718079}
.domain-preview code{min-width:0;font-size:12px;overflow-wrap:anywhere;text-align:right}
</style>
