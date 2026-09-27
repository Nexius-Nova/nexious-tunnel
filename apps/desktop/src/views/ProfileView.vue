<script setup lang="ts">
import { computed, h, ref, watch } from "vue";
import { useMutation, useQuery, useQueryClient } from "@tanstack/vue-query";
import { NAlert, NButton, NDataTable, NForm, NFormItem, NInput, NModal, NSpace, NTag, useDialog, useMessage, type DataTableColumns, type FormInst, type FormRules } from "naive-ui";
import { KeyRound, RefreshCw, ShieldCheck } from "lucide-vue-next";
import { api } from "../api/client";
import { currentUser, changePassword } from "../session";
import { passwordIssue } from "../accountValidation";
import type { LoginSession } from "../types";
import PageHeader from "../components/PageHeader.vue";
import PasswordField from "../components/PasswordField.vue";
import StateBlock from "../components/StateBlock.vue";

const message=useMessage(),dialog=useDialog(),qc=useQueryClient();
const changing=ref(false),busy=ref(false),error=ref(""),formRef=ref<FormInst|null>(null);
const form=ref({current:"",password:"",confirm:""});
const identity=useQuery({queryKey:["identity",computed(()=>currentUser.value?.id)],queryFn:api.me,refetchInterval:60000});
const sessions=useQuery({queryKey:["sessions",computed(()=>currentUser.value?.id)],queryFn:api.sessions,refetchInterval:60000});
watch(()=>identity.data.value,user=>{if(user?.id&&user.id===currentUser.value?.id)currentUser.value=user;});
watch(changing,()=>{form.value={current:"",password:"",confirm:""};error.value="";formRef.value?.restoreValidation();});
const refresh=()=>{void qc.invalidateQueries({queryKey:["identity"]});void qc.invalidateQueries({queryKey:["sessions"]});};
const revoke=useMutation({mutationFn:api.revokeSession,onSuccess:()=>{message.success("该设备已退出登录");refresh();},onError:error=>message.error(error.message)});
const revokeOthers=useMutation({mutationFn:api.revokeOtherSessions,onSuccess:()=>{message.success("其他设备已全部退出登录");refresh();},onError:error=>message.error(error.message)});
const pending=computed(()=>revoke.isPending.value||revokeOthers.isPending.value);
const date=(value?:string|null)=>value?new Date(value).toLocaleString("zh-CN",{hour12:false}):"—";
function device(value:string|null){if(!value)return"未知设备";if(/Nexious|reqwest/i.test(value))return"Nexious 桌面客户端";const browser=/Edg\//.test(value)?"Edge":/Firefox\//.test(value)?"Firefox":/Chrome\//.test(value)?"Chrome":/Safari\//.test(value)?"Safari":"客户端";return browser+(/Windows/.test(value)?" · Windows":/Android/.test(value)?" · Android":/iPhone|iPad/.test(value)?" · iOS":/Mac/.test(value)?" · macOS":/Linux/.test(value)?" · Linux":"");}
function confirmRevoke(session?:LoginSession){dialog.warning({title:session?"退出登录设备":"退出其他全部设备",content:session?'确认退出「'+device(session.userAgent)+'」？该设备需要重新登录。':"保留当前设备，其他全部设备将立即退出登录。",positiveText:"确认退出",negativeText:"取消",onPositiveClick:()=>session?revoke.mutateAsync(session.id).catch(()=>false):revokeOthers.mutateAsync().catch(()=>false)});}
const columns:DataTableColumns<LoginSession>=[
  {title:"登录设备",key:"device",minWidth:190,render:session=>h("div",{class:"session-device"},[h("span",{title:session.userAgent||undefined},device(session.userAgent)),session.current?h(NTag,{size:"tiny",bordered:false,type:"success"},{default:()=>"当前设备"}):null])},
  {title:"来源 IP",key:"ip",width:160,render:session=>session.ip||"—"},
  {title:"最近活跃",key:"lastSeenAt",width:180,render:session=>date(session.lastSeenAt)},
  {title:"登录时间",key:"createdAt",width:180,render:session=>date(session.createdAt)},
  {title:"操作",key:"action",width:95,render:session=>h(NButton,{size:"small",quaternary:true,disabled:session.current||pending.value,onClick:()=>confirmRevoke(session)},{default:()=>session.current?"使用中":"退出登录"})}
];
const rules:FormRules={current:{required:true,message:"请输入当前密码",trigger:"blur"},password:{required:true,trigger:["blur","input"],validator:(_rule,value)=>passwordIssue(value||"")?new Error(passwordIssue(value||"")!):true},confirm:{required:true,trigger:["blur","input"],validator:(_rule,value)=>value===form.value.password?true:new Error("两次输入的密码不一致")}};
async function savePassword(){
  if(busy.value)return;
  try{await formRef.value?.validate();}catch{return;}
  busy.value=true;error.value="";
  try{await changePassword(form.value.current,form.value.password);changing.value=false;refresh();message.success("密码已修改，其他设备已退出登录");}
  catch(value){error.value=value instanceof Error?value.message:String(value);}
  finally{busy.value=false;}
}
</script>
<template>
  <div class="view profile-view">
    <PageHeader title="账号安全" description="查看个人账号、修改密码与管理登录设备。"><n-button @click="refresh"><template #icon><RefreshCw :size="16" /></template>刷新</n-button></PageHeader>
      <StateBlock v-if="identity.isLoading.value||identity.error.value" :loading="identity.isLoading.value" :error="identity.error.value?.message"><n-button v-if="identity.error.value" @click="identity.refetch()">重试</n-button></StateBlock>
      <section v-else class="panel security-panel"><div class="security-heading"><ShieldCheck :size="20" /><div><h2>{{identity.data.value?.username}}</h2><p>{{identity.data.value?.role==='admin'?'管理员':'普通用户'}} · 个人账号</p></div></div><dl class="identity-grid"><div><dt>创建时间</dt><dd>{{date(identity.data.value?.createdAt)}}</dd></div><div><dt>最后登录</dt><dd>{{date(identity.data.value?.lastLoginAt)}}</dd></div><div><dt>隧道 / 配额</dt><dd>{{identity.data.value?.tunnelCount??0}} / {{identity.data.value?.effectiveQuota??'不受限'}}</dd></div></dl></section>
      <section class="panel security-panel password-row"><div><h2>登录密码</h2><p>修改需验证当前密码，成功后其他设备会立即退出登录。</p></div><n-button @click="changing=true"><template #icon><KeyRound :size="16" /></template>修改密码</n-button></section>
      <section class="panel session-panel"><div class="session-heading"><div><h2>登录设备</h2><p>最多保留 10 个设备。发现陌生设备时，请退出该设备并修改密码。</p></div><n-button :disabled="pending||(sessions.data.value?.length??0)<2" :loading="revokeOthers.isPending.value" @click="confirmRevoke()">退出其他设备</n-button></div>
        <StateBlock v-if="sessions.isLoading.value||sessions.error.value" :loading="sessions.isLoading.value" :error="sessions.error.value?.message"><n-button v-if="sessions.error.value" @click="sessions.refetch()">重试</n-button></StateBlock><n-data-table v-else :columns="columns" :data="sessions.data.value||[]" :row-key="row=>row.id" :bordered="false" :scroll-x="850"><template #empty>暂无有效的登录设备</template></n-data-table>
      </section>
    <n-modal v-model:show="changing" preset="card" title="修改登录密码" style="width:min(480px,calc(100vw - 32px))" :mask-closable="!busy" :closable="!busy" :close-on-esc="!busy">
      <n-alert v-if="error" type="error" :bordered="false" class="password-error" role="alert">{{error}}</n-alert>
      <n-form ref="formRef" :model="form" :rules="rules" :disabled="busy" label-placement="top"><n-form-item label="当前密码" path="current"><n-input v-model:value="form.current" type="password" show-password-on="click" :maxlength="200" :input-props="{autocomplete:'current-password','aria-label':'当前密码'}" /></n-form-item><n-form-item label="新密码" path="password"><PasswordField v-model:value="form.password" :disabled="busy" @enter="savePassword" /></n-form-item><n-form-item label="确认新密码" path="confirm"><n-input v-model:value="form.confirm" type="password" show-password-on="click" :maxlength="128" :input-props="{autocomplete:'new-password','aria-label':'确认新密码'}" @keyup.enter="savePassword" /></n-form-item></n-form><template #footer><n-space justify="end"><n-button :disabled="busy" @click="changing=false">取消</n-button><n-button type="primary" :disabled="busy" :loading="busy" @click="savePassword">保存新密码</n-button></n-space></template>
    </n-modal>
  </div>
</template>
<style scoped>
.profile-view{display:flex;flex-direction:column;gap:22px}.security-panel,.session-panel{min-height:0}.security-panel{padding:24px}.security-heading{display:flex;align-items:center;gap:14px}.security-heading>svg{color:var(--accent)}h2{font-size:15px;font-weight:500;margin:0}p{font-size:12px;line-height:1.7;color:var(--text-secondary);margin:7px 0 0}.identity-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:20px;margin:24px 0 0;padding-top:22px;border-top:1px solid var(--border-subtle)}dt{font-size:12px;color:var(--text-secondary)}dd{font-size:13px;margin:9px 0 0}.password-row,.session-heading{display:flex;align-items:center;justify-content:space-between;gap:24px}.session-heading{padding:22px 24px;border-bottom:1px solid var(--border-subtle)}.session-device{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.password-error{margin-bottom:18px}@media(max-width:640px){.identity-grid{grid-template-columns:1fr}.password-row,.session-heading{align-items:flex-start;flex-direction:column;gap:16px}.security-panel,.session-heading{padding:20px}}
</style>
