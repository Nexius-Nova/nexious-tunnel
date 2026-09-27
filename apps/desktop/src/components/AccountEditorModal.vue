<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { NAlert, NButton, NForm, NFormItem, NInput, NInputNumber, NModal, NSelect, NSpace, useMessage, type FormInst, type FormRules } from "naive-ui";
import { Copy, RefreshCw } from "lucide-vue-next";
import { api } from "../api/client";
import { generatePassword, passwordIssue, usernameIssue } from "../accountValidation";
import { currentUser } from "../session";
import type { ManagedUser } from "../types";
import PasswordField from "./PasswordField.vue";

const props = defineProps<{show:boolean;mode:"create"|"edit"|"reset";target:ManagedUser|null;lastAdmin?:boolean}>();
const emit = defineEmits<{close:[];saved:[]}>();
const message = useMessage(), formRef = ref<FormInst|null>(null), busy = ref(false), error = ref("");
const completed = ref(false), passwordVisible = ref(false);
const form = ref({username:"",password:"",role:"user" as "admin"|"user",status:"active" as "active"|"disabled",quota:null as number|null});
let generation = 0;
const self = computed(() => props.target?.id === currentUser.value?.id);
const title = computed(() => completed.value ? props.mode==="create"?"账号已创建":"密码已重置" : props.mode==="create"?"新建账号":props.mode==="reset"?"重置密码":"编辑账号");
const rules = computed<FormRules>(() => ({
  ...(props.mode==="create" ? {username:{required:true,trigger:["blur","input"],validator:(_rule:unknown,value:string)=>usernameIssue(value||"")?new Error(usernameIssue(value||"")!):true}} : {}),
  ...(props.mode!=="edit" ? {password:{required:true,trigger:["blur","input"],validator:(_rule:unknown,value:string)=>passwordIssue(value||"")?new Error(passwordIssue(value||"")!):true}} : {})
}));
watch(() => [props.show,props.mode,props.target?.id] as const, ([show]) => {
  generation++; error.value="";completed.value=false;passwordVisible.value=false;
  form.value={username:show?props.target?.username||"":"",password:"",role:props.target?.role||"user",status:props.target?.status||"active",quota:props.target?.quotaTunnels??null};
  formRef.value?.restoreValidation();
}, {immediate:true});
async function copyPassword() {
  try {await navigator.clipboard.writeText(form.value.password);message.success("临时密码已复制，请通过可信渠道发送给本人");}
  catch {message.error("无法访问剪贴板，请显示密码后手动复制");}
}
async function save() {
  if(busy.value)return;
  try {await formRef.value?.validate();} catch {return;}
  busy.value=true;error.value="";const session=generation,target=props.target,mode=props.mode;
  try {
    if(mode==="create") await api.createUser({username:form.value.username.trim(),password:form.value.password,role:form.value.role,quotaTunnels:form.value.role==="admin"?null:form.value.quota});
    else if(mode==="reset"&&target) await api.resetUserPassword(target.id,form.value.password);
    else if(target) await api.updateUser(target.id,{role:form.value.role,status:form.value.status,quotaTunnels:form.value.role==="admin"?null:form.value.quota});
    if(session!==generation)return;
    emit("saved");
    if(mode==="edit"){message.success("账号设置已保存");emit("close");}else completed.value=true;
  } catch(value) {if(session===generation)error.value=value instanceof Error?value.message:String(value);}
  finally {busy.value=false;}
}
</script>
<template>
  <n-modal :show="show" preset="card" :title="title" style="width:min(500px,calc(100vw - 32px))" :mask-closable="!busy" :closable="!busy" @close="emit('close')" @update:show="value=>{if(!value&&!busy)emit('close')}">
    <template v-if="completed">
      <n-alert type="success" :bordered="false">{{form.username}} 需要使用临时密码登录并设置自己的密码。临时密码仅在当前窗口展示，关闭后不再保留。</n-alert>
      <div class="temporary-secret"><code>{{passwordVisible?form.password:'••••••••••••••••'}}</code><n-button size="small" @click="passwordVisible=!passwordVisible">{{passwordVisible?'隐藏':'显示'}}</n-button><n-button size="small" @click="copyPassword"><template #icon><Copy :size="14" /></template>复制</n-button></div>
    </template>
    <template v-else>
      <n-alert v-if="error" type="error" :bordered="false" class="form-alert" role="alert">{{error}}</n-alert>
      <n-alert v-if="lastAdmin&&mode==='edit'" type="info" :bordered="false" class="form-alert">这是当前唯一启用的管理员，请先新增或启用另一位管理员再降低权限。</n-alert>
      <n-alert v-if="mode==='reset'" type="warning" :bordered="false" class="form-alert">重置后，{{target?.username}} 的全部设备会退出登录，新密码仍需在首次登录时修改。</n-alert>
      <n-form ref="formRef" :model="form" :rules="rules" :disabled="busy" label-placement="top">
        <n-form-item label="用户名" path="username"><n-input v-model:value="form.username" :disabled="mode!=='create'||busy" :maxlength="32" placeholder="3-32 位字母、数字或 . _ -" :input-props="{autocomplete:'off','aria-label':'用户名'}" /></n-form-item>
        <n-form-item v-if="mode!=='edit'" label="临时密码" path="password">
          <div class="password-editor"><PasswordField v-model:value="form.password" :disabled="busy" label="临时密码" @enter="save" /><n-button size="small" :disabled="busy" @click="form.password=generatePassword()"><template #icon><RefreshCw :size="14" /></template>生成随机密码</n-button></div>
        </n-form-item>
        <template v-if="mode!=='reset'">
          <div class="editor-grid">
            <n-form-item label="角色"><n-select v-model:value="form.role" :disabled="busy||self||lastAdmin" :options="[{label:'普通用户',value:'user'},{label:'管理员',value:'admin'}]" /></n-form-item>
            <n-form-item label="隧道配额"><n-input-number v-model:value="form.quota" :disabled="busy||form.role==='admin'" :min="0" :max="10000" :precision="0" clearable :placeholder="form.role==='admin'?'管理员不受限':'留空使用默认值'" /></n-form-item>
          </div>
          <n-form-item v-if="mode==='edit'" label="账号状态"><n-select v-model:value="form.status" :disabled="busy||self||lastAdmin" :options="[{label:'启用',value:'active'},{label:'停用',value:'disabled'}]" /></n-form-item>
          <n-alert v-if="form.role==='admin'&&(!target||target.role!=='admin')" type="warning" :bordered="false">管理员可管理所有账号、节点、服务器部署和隧道，请仅授予可信人员。</n-alert>
          <n-alert v-if="form.status==='disabled'&&target?.status!=='disabled'" type="warning" :bordered="false">停用会撤销全部登录，并停止该账号的隧道；重新启用后需手动启动隧道。</n-alert>
          <p class="form-note">普通用户只能操作自己的隧道。配额为 0 时无法创建，留空时跟随默认配额。</p>
        </template>
      </n-form>
    </template>
    <template #footer><n-space justify="end"><n-button :disabled="busy" @click="emit('close')">{{completed?'完成':'取消'}}</n-button><n-button v-if="!completed" type="primary" :loading="busy" :disabled="busy" @click="save">{{mode==='create'?'创建账号':mode==='reset'?'确认重置':'保存修改'}}</n-button></n-space></template>
  </n-modal>
</template>
<style scoped>
.form-alert{margin-bottom:20px}.editor-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}.password-editor{display:flex;flex-direction:column;gap:12px;width:100%;align-items:flex-start}.form-note{font-size:12px;line-height:1.7;color:var(--text-secondary);margin:12px 0 0}.temporary-secret{display:flex;align-items:center;gap:8px;margin-top:20px;padding:12px;border:1px solid var(--border);border-radius:8px}.temporary-secret code{flex:1;min-width:0;overflow-wrap:anywhere;font-size:13px}@media(max-width:480px){.editor-grid{grid-template-columns:1fr;gap:0}.temporary-secret{flex-wrap:wrap}}
</style>
