<script setup lang="ts">
import { computed, h, onBeforeUnmount, reactive, ref, watch } from "vue";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/vue-query";
import { useRouter } from "vue-router";
import { NAlert, NButton, NDataTable, NDropdown, NInput, NPagination, NSelect, NSpace, NTabPane, NTabs, NTag, useDialog, useMessage, type DataTableColumns } from "naive-ui";
import { MoreHorizontal, Plus, RefreshCw, Search, ShieldCheck } from "lucide-vue-next";
import { api } from "../api/client";
import { currentUser } from "../session";
import type { AuditLog, ManagedUser } from "../types";
import AccountEditorModal from "../components/AccountEditorModal.vue";
import BillingList from "../components/BillingList.vue";
import PageHeader from "../components/PageHeader.vue";
import StateBlock from "../components/StateBlock.vue";

const message=useMessage(),dialog=useDialog(),qc=useQueryClient(),router=useRouter();
const tab=ref("users"),search=ref(""),filters=reactive({page:1,pageSize:20,search:"",role:"all",status:"all"});
const auditPage=ref(1),auditSearch=ref(""),auditFilter=ref("");
const editor=ref(false),mode=ref<"create"|"edit"|"reset">("create"),target=ref<ManagedUser|null>(null);
let searchTimer:ReturnType<typeof setTimeout>|undefined;
watch(search,value=>{if(searchTimer)clearTimeout(searchTimer);searchTimer=setTimeout(()=>{filters.search=value.trim();filters.page=1;},300);});
watch(()=>[filters.role,filters.status,filters.pageSize],()=>{filters.page=1;});
watch([auditSearch,auditFilter],()=>{auditPage.value=1;});
onBeforeUnmount(()=>{if(searchTimer)clearTimeout(searchTimer);});
const users=useQuery({queryKey:["users",filters],queryFn:()=>api.users({...filters}),placeholderData:keepPreviousData});
const audits=useQuery({queryKey:["audit",auditPage,auditSearch,auditFilter],queryFn:()=>api.audit(auditPage.value,20,auditSearch.value.trim(),auditFilter.value),enabled:computed(()=>tab.value==="audit"),placeholderData:keepPreviousData});
watch(()=>users.data.value?.total,total=>{if(total!==undefined)filters.page=Math.min(filters.page,Math.max(1,Math.ceil(total/filters.pageSize)));});
const refresh=()=>{void qc.invalidateQueries({queryKey:["users"]});void qc.invalidateQueries({queryKey:["audit"]});void qc.invalidateQueries({queryKey:["billing"]});};
const remove=useMutation({mutationFn:api.deleteUser,onSuccess:()=>{message.success("账号已删除");refresh();},onError:error=>message.error(error.message)});
const revoke=useMutation({mutationFn:api.revokeUserSessions,onSuccess:()=>{message.success("该账号的全部登录设备已退出");refresh();},onError:error=>message.error(error.message)});
const busy=computed(()=>remove.isPending.value||revoke.isPending.value);
const summary=computed(()=>users.data.value?.summary||{total:0,active:0,admins:0});
const isSelf=(user:ManagedUser)=>user.id===currentUser.value?.id;
const lastAdmin=computed(()=>target.value?.role==="admin"&&target.value.status==="active"&&summary.value.admins<=1);
function openEditor(value:"create"|"edit"|"reset",user:ManagedUser|null=null){mode.value=value;target.value=user;editor.value=true;}
function action(key:string,user:ManagedUser){
  if(busy.value)return;
  if(key==="security"){void router.push("/profile");return;}
  if(key==="edit"||key==="reset"){openEditor(key,user);return;}
  const run=()=>key==="revoke"?revoke.mutateAsync(user.id):remove.mutateAsync(user.id);
  dialog.warning({title:key==="revoke"?"退出全部登录设备":"删除账号",content:key==="revoke"?'确认撤销「'+user.username+'」的全部登录？对方需要重新登录。':'确认永久删除「'+user.username+'」？账号删除后无法恢复。',positiveText:key==="revoke"?"确认退出":"删除账号",negativeText:"取消",
    // 失败必须关闭对话框并把原因显示出来（如需要二次验证），否则用户只会看到“点了没反应”。
    // mutateAsync 自身也会 reject，这里统一消化，避免未处理的 Promise 拒绝。
    onPositiveClick:async()=>{try{await run();}catch{/* 错误提示由 mutation 的 onError 负责 */}}});
}
const date=(value?:string|null)=>value?new Date(value).toLocaleString("zh-CN",{hour12:false}):"从未登录";
const columns:DataTableColumns<ManagedUser>=[
  {title:"账号",key:"username",minWidth:170,render:user=>h("div",{class:"account-cell"},[h("b",user.username),isSelf(user)?h(NTag,{size:"tiny",bordered:false,type:"info"},{default:()=>"当前"}):null])},
  {title:"角色",key:"role",width:120,render:user=>h(NTag,{size:"small",bordered:false,type:user.role==="admin"?"info":"default"},{default:()=>user.role==="admin"?"管理员":"普通用户"})},
  {title:"状态",key:"status",width:160,render:user=>h("div",{class:"account-status"},[h(NTag,{size:"small",bordered:false,type:user.status==="disabled"?"default":"success"},{default:()=>user.status==="disabled"?"已停用":"启用"}),user.mustChangePassword?h(NTag,{size:"small",bordered:false,type:"warning"},{default:()=>"待改密"}):null])},
  {title:"隧道 / 配额",key:"quota",width:155,render:user=>user.role==="admin"?String(user.tunnelCount||0)+" / 不受限":String(user.tunnelCount||0)+" / "+String(user.effectiveQuota??"不限")},
  {title:"最后登录",key:"lastLoginAt",minWidth:174,render:user=>date(user.lastLoginAt)},
  {title:"操作",key:"actions",width:68,align:"right",render:user=>h(NDropdown,{trigger:"click",options:isSelf(user)?[{label:"账号安全",key:"security"}]:[
    {label:"编辑角色与配额",key:"edit"},{label:"重置密码",key:"reset"},{label:"退出全部登录设备",key:"revoke"},
    {type:"divider",key:"divider"},{label:user.tunnelCount?"删除（需先处理隧道）":"删除账号",key:"delete",disabled:Boolean(user.tunnelCount)||(user.role==="admin"&&user.status==="active"&&summary.value.admins<=1)}],onSelect:(key:string)=>action(key,user)},
    {default:()=>h(NButton,{quaternary:true,circle:true,size:"small",disabled:busy.value,"aria-label":"管理账号 "+user.username},{icon:()=>h(MoreHorizontal,{size:17})})})}
];
const actionLabels:Record<string,string>={register:"自助注册",login:"登录",login_failed:"登录失败",logout:"退出登录",password_changed:"修改密码",password_reset:"重置密码",user_created:"创建账号",user_updated:"修改账号",user_deleted:"删除账号",settings_updated:"修改设置",membership_purchased:"购买套餐",sessions_revoked:"撤销登录设备",session_revoked:"撤销单个设备",tunnel_created:"创建隧道",tunnel_updated:"修改隧道",tunnel_deleted:"删除隧道"};
const auditColumns:DataTableColumns<AuditLog>=[
  {title:"时间",key:"created_at",width:180,render:row=>date(row.created_at)},
  {title:"操作者",key:"actor_name",width:135,render:row=>row.actor_name==="anonymous"?"未登录":row.actor_name==="service-token"?"机器凭据":row.actor_name},
  {title:"操作",key:"action",width:145,render:row=>actionLabels[row.action]||row.action},
  {title:"对象",key:"target",width:160,ellipsis:{tooltip:true},render:row=>row.target_id||"—"},
  {title:"来源 IP",key:"ip",width:135,render:row=>row.ip||"—"},
  {title:"详情",key:"detail",minWidth:160,ellipsis:{tooltip:true},render:row=>row.detail||"—"}
];
</script>
<template>
  <div class="view accounts-view">
    <PageHeader title="账号管理" description="管理成员权限、隧道配额与登录安全。">
      <n-space><n-button :disabled="busy" @click="refresh"><template #icon><RefreshCw :size="16" /></template>刷新</n-button><n-button type="primary" :disabled="busy" @click="openEditor('create')"><template #icon><Plus /></template>新建账号</n-button></n-space>
    </PageHeader>
    <div class="account-summary"><ShieldCheck :size="18" /><span>全部 <b>{{summary.total}}</b></span><span>启用 <b>{{summary.active}}</b></span><span>管理员 <b>{{summary.admins}}</b></span></div>
    <n-tabs v-model:value="tab" type="line" animated>
      <n-tab-pane name="users" tab="账号列表">
        <section class="panel account-panel">
          <div class="account-toolbar"><n-input v-model:value="search" clearable :maxlength="32" placeholder="搜索用户名" :input-props="{'aria-label':'搜索用户名'}"><template #prefix><Search :size="15" /></template></n-input>
            <n-select v-model:value="filters.role" :options="[{label:'全部角色',value:'all'},{label:'管理员',value:'admin'},{label:'普通用户',value:'user'}]" aria-label="按角色筛选" />
            <n-select v-model:value="filters.status" :options="[{label:'全部状态',value:'all'},{label:'启用',value:'active'},{label:'已停用',value:'disabled'}]" aria-label="按状态筛选" />
          </div>
          <StateBlock v-if="users.isLoading.value||users.error.value" :loading="users.isLoading.value" :error="users.error.value?.message"><n-button v-if="users.error.value" @click="users.refetch()">重试</n-button></StateBlock>
          <template v-else><div class="table-inset"><n-data-table :columns="columns" :data="users.data.value?.items||[]" :loading="users.isFetching.value" :row-key="row=>row.id" :bordered="false" :scroll-x="900"><template #empty>当前筛选条件下没有账号</template></n-data-table></div>
            <div class="account-pagination"><span>共 {{users.data.value?.total||0}} 个账号</span><n-pagination v-model:page="filters.page" v-model:page-size="filters.pageSize" :item-count="users.data.value?.total||0" show-size-picker :page-sizes="[10,20,50]" :page-slot="5" /></div>
          </template>
        </section>
      </n-tab-pane>
      <n-tab-pane name="billing" tab="配额流水">
        <section class="panel account-panel billing-pane">
          <BillingList scope="all" />
        </section>
      </n-tab-pane>
      <n-tab-pane name="audit" tab="操作审计">
        <section class="panel account-panel">
          <div class="account-toolbar audit-toolbar"><n-input v-model:value="auditSearch" clearable :maxlength="100" placeholder="搜索操作者或对象 ID" :input-props="{'aria-label':'搜索审计日志'}" /><n-select v-model:value="auditFilter" :options="[{label:'全部操作',value:''},...Object.entries(actionLabels).map(([value,label])=>({value,label}))]" aria-label="按操作筛选" /></div>
          <StateBlock v-if="audits.isLoading.value||audits.error.value" :loading="audits.isLoading.value" :error="audits.error.value?.message"><n-button v-if="audits.error.value" @click="audits.refetch()">重试</n-button></StateBlock>
          <template v-else><div class="table-inset"><n-data-table :columns="auditColumns" :data="audits.data.value?.items||[]" :bordered="false" :loading="audits.isFetching.value" :scroll-x="900"><template #empty>暂无匹配的审计记录</template></n-data-table></div><div class="account-pagination"><span>共 {{audits.data.value?.total||0}} 条记录 · 保留 180 天</span><n-pagination v-model:page="auditPage" :item-count="audits.data.value?.total||0" :page-size="20" :page-slot="5" /></div></template>
        </section>
      </n-tab-pane>
    </n-tabs>
    <AccountEditorModal :show="editor" :mode="mode" :target="target" :last-admin="lastAdmin" @close="editor=false" @saved="refresh" />
  </div>
</template>
<style scoped>
.accounts-view{display:flex;flex-direction:column;gap:20px}.account-summary{display:flex;align-items:center;gap:24px;color:var(--text-secondary);font-size:13px}.account-summary>svg{color:var(--accent)}.account-summary b{color:var(--text-primary);margin-left:6px;font-weight:500}.account-panel{min-height:0;overflow:hidden}.billing-pane{padding:18px 20px}.account-toolbar{display:grid;grid-template-columns:minmax(180px,1fr) 140px 140px;gap:12px;padding:18px 20px;border-bottom:1px solid var(--border-subtle)}.audit-toolbar{grid-template-columns:minmax(180px,1fr) 190px}.account-pagination{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:18px 20px;border-top:1px solid var(--border-subtle);font-size:12px;color:var(--text-secondary)}:deep(.account-cell),:deep(.account-status){display:flex;align-items:center;flex-wrap:wrap;gap:8px 10px}:deep(.account-cell b){font-weight:500;overflow-wrap:anywhere}@media(max-width:640px){.account-summary{gap:14px;flex-wrap:wrap}.account-toolbar{grid-template-columns:1fr 1fr;padding:16px}.account-toolbar>.n-input{grid-column:1/-1}.account-pagination{align-items:flex-start;flex-direction:column;padding:16px}.audit-toolbar{grid-template-columns:1fr}.accounts-view{gap:16px}}
</style>
