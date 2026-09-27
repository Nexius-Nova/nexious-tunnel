<script setup lang="ts">
import { ref, watch } from "vue";
import { NAlert, NButton, NInput, NModal } from "naive-ui";
import { api } from "../api/client";
import type { NodeInfo } from "../types";
import BehaviorCaptchaModal from "./BehaviorCaptchaModal.vue";
const props=defineProps<{show:boolean;node:NodeInfo|null}>();
const emit=defineEmits<{close:[];complete:[]}>();
const password=ref(""),error=ref(""),busy=ref(false),captcha=ref(false),backup=ref("");
watch(()=>props.show,show=>{if(show){password.value="";error.value="";backup.value="";captcha.value=false;}});
function confirm(){if(busy.value)return;if(!password.value){error.value="请输入服务器 SSH 密码";return;}captcha.value=true;}
async function reset(ticket:string){
  captcha.value=false;if(busy.value||!props.node)return;busy.value=true;error.value="";
  try{const result=await api.resetNode(props.node.id,password.value,ticket);backup.value=result.backupPath;password.value="";emit("complete");}
  catch(value){error.value=value instanceof Error?value.message:String(value);}
  finally{busy.value=false;}
}
</script>
<template>
  <n-modal :show="show" preset="card" :title="'重置服务器 · '+(node?.name||'')" style="width:min(480px,calc(100vw - 32px))" :mask-closable="!busy" :closable="!busy" :close-on-esc="!busy" @close="emit('close')" @update:show="value=>{if(!value&&!busy)emit('close')}">
    <n-alert v-if="backup" type="success" :bordered="false">Nexious 节点已清除。服务器备份：{{backup}}</n-alert>
    <template v-else>
      <n-alert type="warning" :bordered="false">此操作会清除 Nexious 节点服务、配置及节点数据，并停止该节点的隧道。服务器上的其他网站与服务会保留。</n-alert>
      <p>{{node?.ssh_user}}@{{node?.server_host}}:{{node?.ssh_port}}</p>
      <n-alert v-if="error" type="error" :bordered="false" role="alert">{{error}}</n-alert>
      <n-input v-model:value="password" type="password" show-password-on="click" :disabled="busy" placeholder="服务器 SSH 密码" :input-props="{autocomplete:'off','aria-label':'服务器 SSH 密码'}" @keyup.enter="confirm" />
    </template>
    <template #footer><div class="actions"><n-button :disabled="busy" @click="emit('close')">{{backup?'完成':'取消'}}</n-button><n-button v-if="!backup" type="error" :disabled="busy||!node?.server_host" :loading="busy" @click="confirm">验证并重置</n-button></div></template>
  </n-modal>
  <BehaviorCaptchaModal :show="captcha" purpose="node-reset" :node-id="node?.id" @cancel="captcha=false" @verified="reset" />
</template>
<style scoped>
p{color:var(--text-secondary);overflow-wrap:anywhere}.n-alert{margin-bottom:16px}.actions{display:flex;justify-content:flex-end;gap:10px}
</style>
