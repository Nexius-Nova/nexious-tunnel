<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { NAlert, NButton, NModal, NSpin } from "naive-ui";
import { api } from "../api/client";
const props = defineProps<{show:boolean;purpose:"login"|"node-reset";nodeId?:string}>();
const emit = defineEmits<{verified:[ticket:string];cancel:[]}>();
const challenge = ref<Awaited<ReturnType<typeof api.captcha>> | null>(null);
const points = ref<Array<{x:number;y:number}>>([]), loading = ref(false), verifying = ref(false), error = ref("");
const cursor = ref({x:160,y:90}), keyboard = ref(false);
let generation = 0;
const busy = computed(() => loading.value || verifying.value);
async function load() {
  const current = ++generation; loading.value = true; verifying.value = false; error.value = ""; challenge.value = null; points.value = [];
  try { const value = await api.captcha(props.purpose, props.nodeId); if(current===generation)challenge.value=value; }
  catch(value) { if(current===generation)error.value=value instanceof Error?value.message:String(value); }
  finally { if(current===generation)loading.value=false; }
}
watch(() => props.show, show => { if(show)void load(); else {generation++;loading.value=false;verifying.value=false;} },{immediate:true});
async function select(x:number,y:number) {
  // 需要点击的字符数由服务端决定（3-4 个），这里跟随挑战内容，不能写死。
  const need = challenge.value?.points ?? 3;
  if(busy.value || !challenge.value || points.value.length>=need)return;
  points.value.push({x,y}); if(points.value.length<need)return;
  const current = generation; verifying.value=true; error.value="";
  try { const value=await api.verifyCaptcha({id:challenge.value.id,purpose:props.purpose,nodeId:props.nodeId,points:points.value}); if(current===generation)emit("verified",value.ticket); }
  catch(value){if(current===generation){error.value=value instanceof Error?value.message:String(value);points.value=[];
    // 失败后短暂保留旧图展示错误，再自动换一张新图；若把 challenge 置空，
    // 界面会陷入既无图可点、也没有加载指示的死态。
    window.setTimeout(()=>{ if(current===generation)void load(); },1500);}}
  finally{if(current===generation)verifying.value=false;}
}
function click(event:MouseEvent) { const bounds=(event.currentTarget as HTMLElement).getBoundingClientRect(); void select(Math.max(0,Math.min(320,(event.clientX-bounds.left)/bounds.width*320)),Math.max(0,Math.min(180,(event.clientY-bounds.top)/bounds.height*180))); }
function key(event:KeyboardEvent) {
  if(!["ArrowLeft","ArrowRight","ArrowUp","ArrowDown","Enter"," "].includes(event.key))return;
  event.preventDefault();keyboard.value=true;
  if(event.key==="Enter"||event.key===" ")void select(cursor.value.x,cursor.value.y);
  else {cursor.value.x=Math.max(0,Math.min(320,cursor.value.x+(event.key==="ArrowRight"?5:event.key==="ArrowLeft"?-5:0)));cursor.value.y=Math.max(0,Math.min(180,cursor.value.y+(event.key==="ArrowDown"?5:event.key==="ArrowUp"?-5:0)));}
}
function cancel(){generation++;emit("cancel");}
</script>
<template>
  <n-modal :show="show" preset="card" title="行为验证" style="width:min(390px,calc(100vw - 32px))" :mask-closable="false" @close="cancel" @esc="cancel">
    <n-alert v-if="error" type="error" :bordered="false" role="alert">{{error}}</n-alert>
    <n-spin :show="busy">
      <p aria-live="polite">{{challenge?.instruction||'正在准备验证…'}}</p>
      <button v-if="challenge" type="button" class="captcha-image" aria-label="按提示顺序选择文字，可使用方向键移动光标并按回车选择" :disabled="busy" @click="click" @keydown="key">
        <img :src="challenge.image" alt="文字点选验证码" draggable="false" />
        <span v-for="(point,index) in points" :key="index" class="marker" :style="{left:point.x/320*100+'%',top:point.y/180*100+'%'}">{{index+1}}</span>
        <i v-if="keyboard" class="cursor" :style="{left:cursor.x/320*100+'%',top:cursor.y/180*100+'%'}"></i>
      </button>
    </n-spin>
    <p class="hint">按顺序点击提示中的全部文字。键盘可用方向键移动、回车选择。</p>
    <template #footer><div class="actions"><n-button @click="cancel">取消</n-button><n-button :disabled="busy" @click="load">换一张</n-button></div></template>
  </n-modal>
</template>
<style scoped>
.captcha-image{position:relative;width:100%;padding:0;border:1px solid var(--border-color);border-radius:8px;overflow:hidden;display:block;background:var(--surface);cursor:crosshair;touch-action:manipulation}.captcha-image:focus-visible{outline:2px solid var(--accent);outline-offset:3px}.captcha-image img{display:block;width:100%;pointer-events:none}.marker{position:absolute;transform:translate(-50%,-50%);border-radius:50%;width:24px;height:24px;display:grid;place-items:center;background:var(--accent);color:white;border:2px solid white;pointer-events:none}.cursor{position:absolute;transform:translate(-50%,-50%);width:12px;height:12px;border:2px solid #fff;border-radius:50%;pointer-events:none}.hint{font-size:12px;color:var(--text-secondary);line-height:1.6}.actions{display:flex;gap:10px;justify-content:flex-end}
</style>
