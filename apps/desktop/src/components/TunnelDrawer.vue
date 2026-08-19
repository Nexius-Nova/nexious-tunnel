<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { NButton, NModal, NForm, NFormItem, NInput, NInputNumber, NSelect, NSpace, type FormInst, type FormRules } from 'naive-ui'
import type { NodeInfo, Tunnel, TunnelInput } from '../types'

const props=defineProps<{show:boolean;tunnel:Tunnel|null;nodes:NodeInfo[];loading:boolean}>()
const emit=defineEmits<{close:[];submit:[value:TunnelInput]}>()
const formRef=ref<FormInst|null>(null)
const form=reactive<TunnelInput>({name:'',protocol:'https',localHost:'127.0.0.1',localPort:3000,remotePort:443,nodeId:'',domain:null})
watch(()=>[props.show,props.tunnel,props.nodes] as const,()=>{if(!props.show)return;Object.assign(form,props.tunnel?{name:props.tunnel.name,protocol:props.tunnel.protocol,localHost:props.tunnel.local_host,localPort:props.tunnel.local_port,remotePort:props.tunnel.remote_port,nodeId:props.tunnel.node_id,domain:props.tunnel.domain}:{name:'',protocol:'https',localHost:'127.0.0.1',localPort:3000,remotePort:443,nodeId:props.nodes.find(n=>n.status==='online')?.id||'',domain:null})},{immediate:true})
const nodeOptions=computed(()=>props.nodes.map(n=>({label:`${n.name}${n.status!=='online'?'（维护中）':''}`,value:n.id,disabled:n.status!=='online'})))
const accessUrl=computed(()=>{const host=props.nodes.find(n=>n.id===form.nodeId)?.host;return form.domain&&host?`https://${form.domain}.${host}/`:''})
const rules:FormRules={name:{required:true,min:2,message:'请输入至少 2 个字符的名称',trigger:'blur'},localPort:{type:'number',required:true,message:'请输入本地端口',trigger:['blur','change']},nodeId:{required:true,message:'请选择节点',trigger:'change'},domain:{required:true,trigger:['input','blur'],validator:(_rule,value)=>{if(!value)return new Error('请输入访问子域名');return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value)?true:new Error('仅支持小写字母、数字和连字符')}}}
async function submit(){form.domain=form.domain?.trim().toLowerCase()||null;await formRef.value?.validate();emit('submit',{...form,domain:form.domain})}
</script>
<template>
  <n-modal :show="show" preset="card" :title="tunnel?'编辑隧道':'创建新隧道'" :style="{ width: '460px' }" :mask-closable="false" @close="emit('close')">
    <div class="modal-intro"><b>{{tunnel?'更新连接参数':'将本地服务安全发布到公网'}}</b><span>配置隧道名称、协议、节点及访问域名。</span></div>
    <n-form ref="formRef" :model="form" :rules="rules" label-placement="top">
      <n-form-item label="隧道名称" path="name"><n-input v-model:value="form.name" maxlength="32" placeholder="例如：开发环境 API"/></n-form-item>
      <div class="form-grid">
        <n-form-item label="协议"><n-select v-model:value="form.protocol" :options="['https','http'].map(v=>({label:v.toUpperCase(),value:v}))"/></n-form-item>
        <n-form-item label="边缘节点" path="nodeId"><n-select v-model:value="form.nodeId" :options="nodeOptions"/></n-form-item>
      </div>
      <n-form-item label="本地端口" path="localPort"><n-input-number v-model:value="form.localPort" :min="1" :max="65535" style="width:100%" placeholder="3000"/></n-form-item>
      <n-form-item label="访问子域名" path="domain">
        <div class="domain-field"><n-input v-model:value="form.domain" maxlength="63" placeholder="demo" @update:value="value=>form.domain=value.toLowerCase()"/><div v-if="accessUrl" class="domain-preview"><span>公网访问地址</span><code>{{accessUrl}}</code></div></div>
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
.domain-preview{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:8px;padding:9px 11px;border:1px solid rgba(35,155,97,.24);border-radius:5px;background:rgba(35,155,97,.07);overflow:hidden}
.domain-preview span{flex:none;font-size:11px;color:#718079}
.domain-preview code{min-width:0;font-size:12px;overflow-wrap:anywhere;text-align:right}
</style>
