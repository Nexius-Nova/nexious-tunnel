<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { NAlert, NButton, NInput, NModal, NSpace } from "naive-ui";
import { api } from "../api/client";
import { currentUser, isAuthenticated } from "../session";
import type { VerificationRequest } from "../reauthentication";
const show=ref(false),password=ref(""),busy=ref(false),error=ref("");
let request:VerificationRequest|null=null;
function open(event:Event){request=(event as CustomEvent<VerificationRequest>).detail;password.value="";error.value="";show.value=true;}
function cancel(){if(busy.value)return;request?.reject(new Error("已取消身份验证，操作未执行"));request=null;show.value=false;password.value="";}
async function verify(){
  if(busy.value||!password.value)return;
  busy.value=true;error.value="";
  try{await api.verifyPassword(password.value);request?.resolve();request=null;show.value=false;password.value="";}
  catch(value){error.value=value instanceof Error?value.message:String(value);}
  finally{busy.value=false;}
}
watch(isAuthenticated,value=>{if(!value&&request){request.reject(new Error("登录状态已变化，请重新登录"));request=null;show.value=false;password.value="";}});
onMounted(()=>window.addEventListener("nexious-verify-identity",open));
onBeforeUnmount(()=>{window.removeEventListener("nexious-verify-identity",open);request?.reject(new Error("身份验证已关闭"));});
</script>
<template>
  <n-modal :show="show" preset="card" title="验证当前身份" style="width:min(420px,calc(100vw - 32px))" :mask-closable="!busy" :closable="!busy" @close="cancel" @update:show="value=>{if(!value)cancel()}">
    <p class="verification-note">{{currentUser?.username}}，此操作涉及账号安全。验证成功后将继续执行刚才的操作，验证有效期为 15 分钟。</p>
    <n-alert v-if="error" type="error" :bordered="false" class="verification-error" role="alert">{{error}}</n-alert>
    <n-input v-model:value="password" :disabled="busy" type="password" show-password-on="click" :maxlength="200" placeholder="当前密码" :input-props="{autocomplete:'current-password','aria-label':'验证当前密码'}" @keyup.enter="verify" />
    <template #footer><n-space justify="end"><n-button :disabled="busy" @click="cancel">取消</n-button><n-button type="primary" :loading="busy" :disabled="busy||!password" @click="verify">验证并继续</n-button></n-space></template>
  </n-modal>
</template>
<style scoped>
.verification-note{margin:0 0 20px;color:var(--text-secondary);font-size:13px;line-height:1.8}.verification-error{margin-bottom:16px}
</style>
