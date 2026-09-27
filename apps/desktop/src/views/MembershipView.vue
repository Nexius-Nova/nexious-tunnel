<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useQuery, useQueryClient } from "@tanstack/vue-query";
import { NAlert, NButton, NDatePicker, NForm, NFormItem, NInput, NInputNumber, NModal, NSelect, NSwitch, useMessage } from "naive-ui";
import { Copy, Crown, Gift, Plus } from "lucide-vue-next";
import { api } from "../api/client";
import { isAdmin } from "../session";
import type { MembershipPlan, PaymentOrder, ReferralCampaign } from "../types";
import PageHeader from "../components/PageHeader.vue";
import StateBlock from "../components/StateBlock.vue";
import BillingList from "../components/BillingList.vue";
import MembershipPlanCard from "../components/MembershipPlanCard.vue";
import PaymentModal from "../components/PaymentModal.vue";
import ReferralCampaignCard from "../components/ReferralCampaignCard.vue";

const message=useMessage(),qc=useQueryClient();
const membership=useQuery({queryKey:["membership"],queryFn:api.membership});
const plans=useQuery({queryKey:["plans"],queryFn:api.plans});
const campaigns=useQuery({queryKey:["campaigns"],queryFn:api.campaigns});
const editingPlan=ref(false),editingCampaign=ref(false),grantOpen=ref(false),busy=ref(false),error=ref("");
// 支付流程：0 元套餐下单即开通；付费套餐弹出二维码并轮询订单状态。
const payOpen=ref(false),payBusy=ref(false),payOrder=ref<PaymentOrder|null>(null);
const planId=ref<string>(),campaignId=ref<string>();
const plan=ref<Omit<MembershipPlan,"id">>({name:"",description:"",priceCents:0,durationDays:30,tunnelQuota:5,enabled:true});
const campaign=ref<Omit<ReferralCampaign,"id">>({name:"",inviterBonus:0,inviteeBonus:0,maxRewards:10,startsAt:"",endsAt:"",enabled:true});
const starts=ref<number|null>(null),ends=ref<number|null>(null);
const users=ref<Array<{label:string;value:string}>>([]),userLoading=ref(false),grantUser=ref<string|null>(null),grantPlan=ref<string|null>(null),grantRequest=ref("");
let userGeneration=0;
const activePlans=computed(()=>(plans.data.value||[]).filter(value=>value.enabled).map(value=>({label:value.name,value:value.id})));
const email=ref(""),code=ref(""),emailId=ref(""),sentEmail=ref(""),mailBusy=ref(false),binding=ref(false),mailUntil=ref(0),clock=ref(Date.now()),emailError=ref("");
const seconds=computed(()=>Math.max(0,Math.ceil((mailUntil.value-clock.value)/1000)));
const timer=setInterval(()=>{clock.value=Date.now();},1000);
onBeforeUnmount(()=>{clearInterval(timer);userGeneration++;});
const date=(value?:string|null)=>value?new Date(value).toLocaleString("zh-CN",{hour12:false}):"—";
const failure=(value:unknown)=>value instanceof Error?value.message:String(value);
function refresh(){for(const key of ["membership","plans","campaigns","users","identity","audit","billing"])void qc.invalidateQueries({queryKey:[key]});}
async function buy(value:MembershipPlan){
  if(payBusy.value)return;payBusy.value=true;error.value="";
  try{
    const order=await api.createBillingOrder(value.id,crypto.randomUUID());
    if(order.status==="paid"){refresh();message.success(order.amountCents>0?"支付成功，套餐已开通":"已开通，有效期至 "+date(order.membershipUntil));}
    else{payOrder.value=order;payOpen.value=true;}
  }
  catch(value2){message.error(failure(value2));}
  finally{payBusy.value=false;}
}
function onPaid(){payOpen.value=false;refresh();message.success("支付成功，套餐已开通");}
function openPlan(value?:MembershipPlan){planId.value=value?.id;plan.value=value?{name:value.name,description:value.description,priceCents:value.priceCents,durationDays:value.durationDays,tunnelQuota:value.tunnelQuota,enabled:value.enabled}:{name:"",description:"",priceCents:0,durationDays:30,tunnelQuota:5,enabled:true};error.value="";editingPlan.value=true;}
function openCampaign(value?:ReferralCampaign){campaignId.value=value?.id;campaign.value=value?{name:value.name,inviterBonus:value.inviterBonus,inviteeBonus:value.inviteeBonus,maxRewards:value.maxRewards,startsAt:value.startsAt,endsAt:value.endsAt,enabled:value.enabled}:{name:"",inviterBonus:0,inviteeBonus:0,maxRewards:10,startsAt:"",endsAt:"",enabled:true};starts.value=value?Date.parse(value.startsAt):Date.now();ends.value=value?Date.parse(value.endsAt):Date.now()+30*86400000;error.value="";editingCampaign.value=true;}
async function save(kind:"plan"|"campaign"){
  if(busy.value)return;error.value="";
  if(kind==="plan"&&!plan.value.name.trim()||kind==="campaign"&&!campaign.value.name.trim()){error.value="请输入名称";return;}
  if(kind==="campaign"&&(!starts.value||!ends.value||ends.value<=starts.value)){error.value="请选择有效的活动起止时间";return;}
  busy.value=true;
  try{if(kind==="plan"){await api.savePlan(plan.value,planId.value);editingPlan.value=false;}else{await api.saveCampaign({...campaign.value,startsAt:new Date(starts.value!).toISOString(),endsAt:new Date(ends.value!).toISOString()},campaignId.value);editingCampaign.value=false;}refresh();message.success("已保存");}
  catch(value){error.value=failure(value);}finally{busy.value=false;}
}
async function searchUsers(search=""){
  const current=++userGeneration;userLoading.value=true;
  try{const result=await api.users({search:search.slice(0,32),status:"active",pageSize:20});if(current===userGeneration)users.value=result.items.map(user=>({label:user.username,value:user.id}));}
  catch(value){if(current===userGeneration)error.value=failure(value);}finally{if(current===userGeneration)userLoading.value=false;}
}
function openGrant(){grantUser.value=null;grantPlan.value=null;error.value="";grantOpen.value=true;void searchUsers();}
watch([grantUser,grantPlan],()=>{grantRequest.value=crypto.randomUUID();});
async function grant(){
  if(busy.value)return;if(!grantUser.value||!grantPlan.value){error.value="请选择账号和套餐";return;}
  busy.value=true;error.value="";
  try{const value=await api.grantMembership(grantUser.value,grantPlan.value,grantRequest.value);grantOpen.value=false;refresh();message.success("已开通，有效期至 "+date(value.expiresAt));}
  catch(value){error.value=failure(value);}finally{busy.value=false;}
}
async function copy(){try{await navigator.clipboard.writeText(membership.data.value!.inviteCode);message.success("邀请码已复制");}catch{message.error("复制失败，请手动复制邀请码");}}
async function sendCode(){
  if(mailBusy.value||binding.value||seconds.value)return;
  const address=email.value.trim().toLowerCase();if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)){emailError.value="请输入有效邮箱";return;}
  mailBusy.value=true;emailError.value="";
  try{const value=await api.bindEmailCode(address);emailId.value=value.verificationId;sentEmail.value=address;mailUntil.value=Date.now()+value.retryAfter*1000;message.success("验证码已发送");}
  catch(value){emailError.value=failure(value);}finally{mailBusy.value=false;}
}
async function bind(){
  if(binding.value||mailBusy.value)return;
  const address=email.value.trim().toLowerCase();if(!emailId.value||address!==sentEmail.value||!/^\d{6}$/.test(code.value)){emailError.value="请向当前邮箱发送并填写六位验证码";return;}
  binding.value=true;emailError.value="";
  try{await api.bindEmail({email:address,verificationId:emailId.value,code:code.value});code.value="";refresh();message.success("邮箱已绑定");}
  catch(value){emailError.value=failure(value);}finally{binding.value=false;}
}
</script>
<template>
  <div class="view membership-view">
    <PageHeader title="会员与邀请" description="查看套餐权益，邀请朋友使用 Nexious Tunnel。"><n-button v-if="isAdmin" :disabled="!activePlans.length" @click="openGrant">开通会员</n-button></PageHeader>
    <StateBlock v-if="membership.isLoading.value||membership.error.value" :loading="membership.isLoading.value" :error="membership.error.value?.message"><n-button @click="membership.refetch()">重试</n-button></StateBlock>
    <section v-else class="panel current-membership"><Crown :size="24"/><div><h2>{{membership.data.value?.membershipActive?membership.data.value.planName:'基础账号'}}</h2><p>{{membership.data.value?.membershipActive?'有效期至 '+date(membership.data.value.membershipUntil):'开通套餐后即可创建隧道'}} · 隧道配额 {{membership.data.value?.effectiveQuota??'不限'}}</p></div></section>
    <section class="plans-section"><div class="section-heading"><div><h2>会员套餐</h2><p>选择适合你的隧道配额，支持支付宝扫码购买。</p></div><n-button v-if="isAdmin" @click="openPlan()"><template #icon><Plus :size="16"/></template>添加套餐</n-button></div>
      <StateBlock v-if="plans.isLoading.value||plans.error.value" :loading="plans.isLoading.value" :error="plans.error.value?.message"><n-button @click="plans.refetch()">重试</n-button></StateBlock>
      <div v-else-if="!plans.data.value?.length" class="empty panel">暂无套餐{{isAdmin?'，可添加价格、有效期和隧道配额。':'，请稍后查看。'}}</div>
      <div v-else class="plan-grid"><MembershipPlanCard v-for="value in plans.data.value" :key="value.id" :plan="value" :admin="isAdmin" :membership-active="membership.data.value?.membershipActive??false" @edit="openPlan" @buy="buy"/></div>
    </section>
    <section class="panel invitation-panel"><div class="section-heading"><div><h2><Gift :size="18"/> 邀请推广</h2><p>分享邀请码，与朋友一起获得隧道配额。</p></div><n-button v-if="isAdmin" @click="openCampaign()"><template #icon><Plus :size="16"/></template>添加活动</n-button></div>
      <div class="referral-layout" :class="{ 'referral-layout--single': !membership.data.value }"><div class="campaign-list">
      <StateBlock v-if="campaigns.isLoading.value||campaigns.error.value" :loading="campaigns.isLoading.value" :error="campaigns.error.value?.message"><n-button @click="campaigns.refetch()">重试</n-button></StateBlock>
      <div v-else-if="!campaigns.data.value?.length" class="campaign-empty"><Gift :size="24"/><h3>暂时没有奖励活动</h3><p>仍可分享邀请码，活动开启后再查看奖励。</p></div>
      <template v-else><ReferralCampaignCard v-for="value in campaigns.data.value" :key="value.id" :campaign="value" :admin="isAdmin" :now="clock" @edit="openCampaign"/></template>
      </div>
      <aside v-if="membership.data.value" class="referral-summary" aria-label="我的邀请记录">
        <div class="invite-code"><div><small>我的邀请码</small><code>{{membership.data.value.inviteCode}}</code></div><n-button :disabled="!membership.data.value.email" :title="!membership.data.value.email ? '绑定邮箱后即可分享邀请码' : undefined" @click="copy"><template #icon><Copy :size="15"/></template>复制</n-button></div>
        <dl class="referral-stats"><div><dt>已邀请</dt><dd>{{membership.data.value.invitedCount}}<small> 人</small></dd></div><div><dt>已奖励</dt><dd>{{membership.data.value.rewardedCount}}<small> 次</small></dd></div><div><dt>奖励配额</dt><dd>{{membership.data.value.bonusTunnels}}<small> 条</small></dd></div></dl>
        <ol class="referral-steps"><li>分享邀请码给朋友</li><li>朋友注册并完成邮箱验证</li><li>符合活动条件，自动发放奖励</li></ol>
      </aside></div>
      <p class="referral-note">奖励配额上限为 10000 条；隧道配额严格按套餐发放，邀请奖励与管理员调整叠加在套餐之上。</p>
      <template v-if="membership.data.value">
        <div v-if="!membership.data.value.email" class="email-binding"><n-alert type="info" :bordered="false">绑定邮箱后即可参与邀请活动。</n-alert><n-alert v-if="emailError" type="error" :bordered="false">{{emailError}}</n-alert><n-input v-model:value="email" :disabled="mailBusy||binding" placeholder="邮箱" :input-props="{autocomplete:'email','aria-label':'绑定邮箱'}"/><div class="email-code"><n-input v-model:value="code" :disabled="binding" :maxlength="6" placeholder="六位验证码" :input-props="{autocomplete:'one-time-code','aria-label':'绑定邮箱验证码'}"/><n-button :loading="mailBusy" :disabled="seconds>0||mailBusy||binding" @click="sendCode">{{seconds?seconds+' 秒':'发送验证码'}}</n-button><n-button type="primary" :loading="binding" :disabled="binding||mailBusy" @click="bind">绑定</n-button></div></div>
      </template>
    </section>
    <section class="panel billing-panel"><BillingList scope="mine" /></section>
    <n-modal v-model:show="editingPlan" preset="card" :title="planId?'编辑套餐':'添加套餐'" style="width:min(480px,calc(100vw - 32px))" :mask-closable="!busy" :closable="!busy" :close-on-esc="!busy"><n-alert v-if="error" type="error">{{error}}</n-alert><n-form label-placement="top" :disabled="busy"><n-form-item label="名称"><n-input v-model:value="plan.name" :maxlength="64"/></n-form-item><n-form-item label="说明"><n-input v-model:value="plan.description" type="textarea" :maxlength="500"/></n-form-item><n-form-item label="价格（分）"><n-input-number v-model:value="plan.priceCents" :min="0" :max="100000000" :precision="0"/></n-form-item><n-form-item label="有效期（天）"><n-input-number v-model:value="plan.durationDays" :min="1" :max="3650" :precision="0"/></n-form-item><n-form-item label="隧道配额"><n-input-number v-model:value="plan.tunnelQuota" :min="0" :max="10000" :precision="0"/></n-form-item><n-form-item label="启用"><n-switch v-model:value="plan.enabled"/></n-form-item></n-form><template #footer><n-button type="primary" :loading="busy" :disabled="busy" @click="save('plan')">保存套餐</n-button></template></n-modal>
    <n-modal v-model:show="editingCampaign" preset="card" :title="campaignId?'编辑活动':'添加活动'" style="width:min(480px,calc(100vw - 32px))" :mask-closable="!busy" :closable="!busy" :close-on-esc="!busy"><n-alert v-if="error" type="error">{{error}}</n-alert><n-form label-placement="top" :disabled="busy"><n-form-item label="活动名称"><n-input v-model:value="campaign.name" :maxlength="64"/></n-form-item><n-form-item label="邀请人奖励（隧道条数）"><n-input-number v-model:value="campaign.inviterBonus" :min="0" :max="10000" :precision="0"/></n-form-item><n-form-item label="受邀人奖励（隧道条数）"><n-input-number v-model:value="campaign.inviteeBonus" :min="0" :max="10000" :precision="0"/></n-form-item><n-form-item label="每位邀请人最多奖励次数"><n-input-number v-model:value="campaign.maxRewards" :min="1" :max="10000" :precision="0"/></n-form-item><n-form-item label="开始时间"><n-date-picker v-model:value="starts" type="datetime"/></n-form-item><n-form-item label="结束时间"><n-date-picker v-model:value="ends" type="datetime"/></n-form-item><n-form-item label="启用"><n-switch v-model:value="campaign.enabled"/></n-form-item></n-form><template #footer><n-button type="primary" :loading="busy" :disabled="busy" @click="save('campaign')">保存活动</n-button></template></n-modal>
    <n-modal v-model:show="grantOpen" preset="card" title="开通会员" style="width:min(440px,calc(100vw - 32px))" :mask-closable="!busy" :closable="!busy" :close-on-esc="!busy"><n-alert v-if="error" type="error">{{error}}</n-alert><p>开通由管理员确认。续期会在现有有效期后增加套餐天数，配额使用所选套餐。</p><n-form label-placement="top" :disabled="busy"><n-form-item label="账号"><n-select v-model:value="grantUser" filterable remote :options="users" :loading="userLoading" placeholder="搜索用户名" @search="searchUsers"/></n-form-item><n-form-item label="套餐"><n-select v-model:value="grantPlan" :options="activePlans"/></n-form-item></n-form><template #footer><n-button type="primary" :loading="busy" :disabled="busy" @click="grant">确认开通</n-button></template></n-modal>
    <PaymentModal :show="payOpen" :order="payOrder" @close="payOpen=false" @paid="onPaid" />
  </div>
</template>
<style scoped>
.membership-view { display: flex; flex-direction: column; gap: 24px; }
.membership-view :deep(.page-header) { margin-bottom: 0; }
.membership-view .panel { min-height: 0; }
.current-membership { display: flex; gap: 16px; align-items: center; padding: 18px 22px; }
.current-membership > svg { color: var(--accent); flex-shrink: 0; }
.current-membership p { margin: 4px 0 0; }
h2 { font-size: 16px; margin: 0; }
h3 { font-size: 15px; margin: 0; }
p { font-size: 12px; color: var(--text-secondary); line-height: 1.8; margin: 8px 0; }
.section-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 16px; }
.section-heading h2 { display: flex; gap: 8px; align-items: center; }
.section-heading p { margin: 4px 0 0; }
.section-heading > .n-button { flex-shrink: 0; }
.empty { padding: 24px 20px; color: var(--text-secondary); text-align: center; }
.plans-section { min-width: 0; container-type: inline-size; container-name: plans; }
.plan-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 16px; align-items: stretch; }
.invitation-panel { padding: 24px; }
.billing-panel { padding: 24px; }
.referral-layout { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; align-items: start; }
.referral-layout--single { grid-template-columns: 1fr; }
.campaign-list { display: grid; gap: 12px; min-width: 0; }
.campaign-empty { padding: 28px 18px; text-align: center; border: 1px dashed var(--border); border-radius: var(--radius); }
.campaign-empty > svg { color: var(--text-muted); margin-bottom: 12px; }
.referral-summary { min-width: 0; }
.invite-code { display: flex; align-items: center; justify-content: space-between; gap: 12px; background: var(--surface-raised); border: 1px solid var(--border); border-radius: var(--radius); padding: 16px; }
.invite-code > div { min-width: 0; }
.invite-code small { display: block; color: var(--text-secondary); margin-bottom: 6px; }
.invite-code code { font-size: 16px; overflow-wrap: anywhere; }
.invite-code > .n-button { flex-shrink: 0; }
.referral-stats { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; margin: 14px 0; }
.referral-stats > div { padding: 12px; border: 1px solid var(--border-subtle); border-radius: var(--radius-sm); min-width: 0; }
.referral-stats dt { color: var(--text-secondary); font-size: 12px; }
.referral-stats dd { margin: 6px 0 0; font-size: 24px; line-height: 1.2; font-weight: 500; overflow-wrap: anywhere; }
.referral-stats dd small { font-size: 12px; color: var(--text-secondary); font-weight: 400; }
.referral-steps { margin: 16px 0 0; padding-left: 20px; color: var(--text-secondary); font-size: 12px; line-height: 1.8; display: grid; gap: 6px; }
.referral-steps li::marker { color: var(--accent); }
.referral-note { padding-top: 16px; border-top: 1px solid var(--border-subtle); margin: 20px 0 0; }
.email-binding { display: flex; flex-direction: column; gap: 12px; max-width: 480px; margin-top: 18px; }
.email-code { display: flex; gap: 8px; min-width: 0; }
.email-code .n-input { min-width: 0; }
.n-form { margin-top: 16px; }
.n-input-number, .n-date-picker { width: 100%; }
@container plans (max-width: 899px) { .plan-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@container plans (max-width: 459px) { .plan-grid { grid-template-columns: 1fr; } }
@media (max-width: 1000px) { .referral-layout { grid-template-columns: 1fr; } }
@media (max-width: 560px) {
  .current-membership, .invitation-panel { padding: 18px; }
  .email-code { flex-wrap: wrap; }
  .email-code .n-input { width: 100%; }
  .referral-stats { gap: 8px; }
  .referral-stats > div { padding: 10px; }
}
</style>
