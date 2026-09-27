<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { isTauri } from "@tauri-apps/api/core";
import { NAlert, NButton, NCheckbox, NForm, NFormItem, NInput, useMessage, type FormInst, type FormRules } from "naive-ui";
import { ArrowLeft, ArrowRight, Eye, EyeOff, KeyRound, Sparkles, User, Zap } from "lucide-vue-next";
import { api, ApiError } from "../api/client";
import TunnelIllustration from "../components/TunnelIllustration.vue";
import PasswordField from "../components/PasswordField.vue";
import BehaviorCaptchaModal from "../components/BehaviorCaptchaModal.vue";
import { passwordIssue, usernameIssue } from "../accountValidation";
import { changePassword, getApiEndpoint, login, logout, mustChangePassword, register, storageWarning } from "../session";

const message = useMessage();
const emitted = defineEmits<{ done: [] }>();
type Step = "login" | "register" | "password";
const step = ref<Step>(mustChangePassword.value ? "password" : "login");
const busy = ref(false), formRef = ref<FormInst | null>(null);
const registrationEnabled = ref(false), showPassword = ref(false), remember = ref(false);
const native = isTauri(), endpoint = ref(""), statusLoading = ref(true), statusError = ref(""), submitError = ref("");
const retryUntil = ref(0), clock = ref(Date.now());
const captchaOpen = ref(false), mailBusy = ref(false), verificationId = ref(""), sentEmail = ref(""), mailUntil = ref(0);
const mailSeconds = computed(() => Math.max(0,Math.ceil((mailUntil.value-clock.value)/1000)));
const retrySeconds = computed(() => Math.max(0, Math.ceil((retryUntil.value - clock.value) / 1000)));
let timer: ReturnType<typeof setInterval> | undefined;
let statusGeneration = 0;
const form = ref({ username: "", password: "", confirm: "", newPassword: "", confirmNew: "", email:"", code:"", inviteCode:"" });
const issueRule = (check: (value:string)=>string|null) => ({ required: true, trigger: ["blur","input"], validator: (_rule:unknown,value:string) => check(value || "") ? new Error(check(value || "")!) : true });
const loginRules: FormRules = {
  username: { required: true, message: "请输入用户名", trigger: "blur" },
  password: { required: true, message: "请输入密码", trigger: "blur" }
};
const registerRules: FormRules = {
  email: issueRule(value => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? null : "请输入有效邮箱"),
  code: issueRule(value => /^\d{6}$/.test(value) ? null : "请输入六位邮箱验证码"),
  username: issueRule(usernameIssue), password: issueRule(passwordIssue),
  confirm: { required:true,trigger:["blur","input"],validator:(_rule,value)=>value === form.value.password ? true : new Error("两次输入的密码不一致") }
};
const passwordRules: FormRules = {
  password: loginRules.password, newPassword: issueRule(passwordIssue),
  confirmNew: { required:true,trigger:["blur","input"],validator:(_rule,value)=>value === form.value.newPassword ? true : new Error("两次输入的密码不一致") }
};
const rules = computed(() => step.value === "register" ? registerRules : step.value === "password" ? passwordRules : loginRules);
const heading = computed(() => step.value === "password" ? {title:"设置你自己的密码",desc:"临时密码仅用于首次登录，修改后才能进入工作台。"} :
  step.value === "register" ? {title:"创建账号",desc:"新账号可管理自己的隧道，权限和配额由管理员配置。"} :
  {title:"登录控制中心",desc:"使用个人账号管理隧道与查看运行情况。"});
const submitLabel = computed(() => retrySeconds.value ? retrySeconds.value + " 秒后重试" : step.value === "password" ? "保存并进入" : step.value === "register" ? "注册并进入" : "登录");
const localAvailable = computed(() => native && /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/|$)/.test(endpoint.value));
const errorText = (error:unknown) => error instanceof Error ? error.message : String(error);
async function loadStatus() {
  const generation = ++statusGeneration;
  statusLoading.value = true; statusError.value = ""; registrationEnabled.value = false;
  const deadline = Date.now() + 12_000;
  try {
    const currentEndpoint = await getApiEndpoint();
    if (generation !== statusGeneration) return;
    endpoint.value = currentEndpoint;
    for (;;) {
      if (generation !== statusGeneration) return;
      try {
        const status = await api.authStatus();
        if (generation === statusGeneration) registrationEnabled.value = status.registrationEnabled;
        break;
      } catch (error) {
        // 内置服务与窗口同时启动，只对“服务可能仍在启动”的连接失败短暂重试。
        // 配置缺失、依赖缺失等确定性失败立即上报，否则按钮会被长时间禁用。
        if (!localAvailable.value || !(error instanceof ApiError) || error.status !== 0) throw error;
        if (/启动失败|运行资源|MySQL|依赖缺失/.test(error.message) || Date.now() >= deadline) throw error;
        await new Promise(resolve => setTimeout(resolve, 800));
      }
    }
  } catch (error) {
    if (generation === statusGeneration) {
      statusError.value = error instanceof ApiError && [401, 404].includes(error.status)
        ? "当前控制中心不支持账号登录，请更新控制中心后重新连接。"
        : errorText(error) || "暂时无法连接控制中心，请检查服务地址后重试。";
    }
  } finally { if (generation === statusGeneration) statusLoading.value = false; }
}
onMounted(() => { void loadStatus(); timer = setInterval(() => {clock.value = Date.now();},1000); });
onBeforeUnmount(() => {statusGeneration++;if(timer)clearInterval(timer);});
async function submit(captchaTicket?:string) {
  if (busy.value || retrySeconds.value) return;
  // 状态检查未完成时不再静默忽略点击，明确告知用户当前进度。
  if (statusLoading.value) { message.warning("正在连接控制中心，请稍候"); return; }
  if (statusError.value) { message.warning("尚未连接控制中心，请点击上方“重新连接”后重试"); return; }
  try { await formRef.value?.validate(); } catch { return; }
  if(step.value==="login"&&!captchaTicket){captchaOpen.value=true;return;}
  if(step.value==="register"&&(!verificationId.value||sentEmail.value!==form.value.email.trim().toLowerCase())){submitError.value="请先向当前邮箱发送验证码";return;}
  busy.value = true; submitError.value = "";
  try {
    if (step.value === "password") {
      await changePassword(form.value.password,form.value.newPassword);
      message.success("密码已修改，其他设备已退出登录");
    } else {
      const user = step.value === "register" ? await register({username:form.value.username.trim(),password:form.value.password,email:form.value.email.trim().toLowerCase(),verificationId:verificationId.value,code:form.value.code,...(form.value.inviteCode.trim()?{inviteCode:form.value.inviteCode.trim()}: {})},remember.value) : await login(form.value.username.trim(),form.value.password,captchaTicket!,remember.value);
      if (user.mustChangePassword) { toStep("password"); return; }
      message.success("欢迎，" + user.username);
    }
    form.value.password = ""; form.value.newPassword = ""; form.value.confirm = ""; form.value.confirmNew = "";
    if (storageWarning.value) message.warning(storageWarning.value);
    emitted("done");
  } catch (error) {
    submitError.value = errorText(error);
    if (error instanceof ApiError && error.status === 429) retryUntil.value = Date.now() + (error.retryAfter || 60) * 1000;
  } finally { busy.value = false; }
}
async function sendCode() {
  if(mailBusy.value||mailSeconds.value)return;
  const email=form.value.email.trim().toLowerCase();
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)){submitError.value="请输入有效邮箱";return;}
  mailBusy.value=true;submitError.value="";
  try{const value=await api.emailCode(email);verificationId.value=value.verificationId;sentEmail.value=email;mailUntil.value=Date.now()+value.retryAfter*1000;message.success("验证码已发送，请检查邮箱");}
  catch(error){submitError.value=errorText(error);if(error instanceof ApiError&&error.status===429)mailUntil.value=Date.now()+(error.retryAfter||60)*1000;}
  finally{mailBusy.value=false;}
}
function verified(ticket:string){captchaOpen.value=false;void submit(ticket);}
function toStep(next:Step) {
  step.value = next; showPassword.value = false; submitError.value = "";
  form.value.password = ""; form.value.confirm = ""; form.value.newPassword = ""; form.value.confirmNew = "";
  formRef.value?.restoreValidation();
}
async function backToLogin() {
  if (step.value === "password") await logout().catch(() => {});
  toStep("login");
}
</script>

<template>
  <div class="auth">
    <!-- 左栏：品牌叙事，登录时才展示，给出产品气质而非空白背景 -->
    <aside class="auth-aside">
      <div class="aside-top">
        <div class="aside-mark"><Zap :size="18" fill="currentColor" /></div>
        <div class="aside-brand"><b>NEXIOUS</b><span>TUNNEL</span></div>
      </div>
      <div class="aside-body">
        <h2>把本地服务<br />安全送到公网</h2>
        <p>一个控制中心管理全部边缘节点与隧道，本地应用无需任何改造。</p>
        <ul class="aside-points">
          <li><i></i>边缘节点一键部署，自动签发 HTTPS</li>
          <li><i></i>HTTP 与 WebSocket 全量代理</li>
          <li><i></i>账号隔离，隧道按归属管理</li>
        </ul>
        <TunnelIllustration />
      </div>
      <div class="aside-foot"><span>SECURE TUNNELING</span></div>
    </aside>

    <!-- 右栏：表单 -->
    <section class="auth-main">
      <div class="auth-card">
        <header class="auth-head">
          <div class="auth-icon">
            <KeyRound v-if="step === 'password'" :size="18" />
            <Sparkles v-else-if="step === 'register'" :size="18" />
            <Zap v-else :size="18" />
          </div>
          <div>
            <h1>{{ heading.title }}</h1>
            <p>{{ heading.desc }}</p>
          </div>
        </header>
        <n-alert v-if="statusError" type="warning" :bordered="false" class="auth-feedback">{{statusError}} <n-button text size="small" :loading="statusLoading" @click="loadStatus">重新连接</n-button></n-alert>
        <n-alert v-if="submitError" type="error" :bordered="false" class="auth-feedback" role="alert">{{submitError}}</n-alert>

        <n-form ref="formRef" :model="form" :rules="rules" label-placement="top" :show-label="false" :disabled="busy">
          <n-form-item v-if="step !== 'password'" path="username">
            <n-input
              v-model:value="form.username"
              size="large"
              placeholder="用户名"
              :input-props="{ autocomplete: 'username', 'aria-label': '用户名' }"
              :maxlength="32"
              @keyup.enter="submit()"
            >
              <template #prefix><User :size="15" /></template>
            </n-input>
          </n-form-item>

          <n-form-item path="password">
            <n-input
              v-model:value="form.password"
              size="large"
              :type="showPassword ? 'text' : 'password'"
              :placeholder="step === 'password' ? '当前密码' : '密码'"
              :input-props="{autocomplete:step==='register'?'new-password':'current-password','aria-label':step==='password'?'当前密码':'密码'}"
              :maxlength="step==='register'?128:200"
              @keyup.enter="submit()"
            >
              <template #prefix><KeyRound :size="15" /></template>
              <template #suffix>
                <button
                  type="button"
                  class="eye-btn"
                  :title="showPassword ? '隐藏密码' : '显示密码'"
                  :aria-label="showPassword ? '隐藏密码' : '显示密码'"
                  @click="showPassword = !showPassword"
                >
                  <EyeOff v-if="showPassword" :size="15" />
                  <Eye v-else :size="15" />
                </button>
              </template>
            </n-input>
          </n-form-item>

          <p v-if="step==='register'" class="password-guide">至少 8 位，最多 128 位。推荐长密码或密码短语，允许空格与中文。</p>
          <n-form-item v-if="step === 'register'" path="confirm">
            <n-input
              v-model:value="form.confirm"
              size="large"
              :type="showPassword ? 'text' : 'password'"
              placeholder="确认密码"
              :input-props="{autocomplete:'new-password','aria-label':'确认密码'}"
              @keyup.enter="submit()"
            />
          </n-form-item>
          <template v-if="step === 'register'">
            <n-form-item path="email"><n-input v-model:value="form.email" size="large" placeholder="邮箱" :maxlength="254" :disabled="mailBusy" :input-props="{autocomplete:'email','aria-label':'邮箱'}" /></n-form-item>
            <n-form-item path="code"><div class="email-code"><n-input v-model:value="form.code" placeholder="六位邮箱验证码" :maxlength="6" :input-props="{autocomplete:'one-time-code',inputmode:'numeric','aria-label':'邮箱验证码'}" /><n-button :loading="mailBusy" :disabled="mailBusy||mailSeconds>0||statusLoading" @click="sendCode">{{mailSeconds?mailSeconds+' 秒':'发送验证码'}}</n-button></div></n-form-item>
            <n-form-item><n-input v-model:value="form.inviteCode" placeholder="邀请码（选填）" :maxlength="16" :input-props="{'aria-label':'邀请码'}" /></n-form-item>
          </template>
          <template v-if="step === 'password'">
            <n-form-item path="newPassword">
              <PasswordField v-model:value="form.newPassword" size="large" :disabled="busy" @enter="submit()" />
            </n-form-item>
            <n-form-item path="confirmNew">
              <n-input
                v-model:value="form.confirmNew"
                size="large"
                :type="showPassword ? 'text' : 'password'"
                placeholder="确认新密码"
                :input-props="{autocomplete:'new-password','aria-label':'确认新密码'}"
                @keyup.enter="submit()"
              />
            </n-form-item>
          </template>
        </n-form>

        <n-checkbox v-if="native&&step!=='password'" v-model:checked="remember" :disabled="busy">在此设备保持登录（最长 30 天）</n-checkbox>
        <n-button class="auth-submit" type="primary" size="large" block :loading="busy" :disabled="busy||statusLoading||retrySeconds>0" @click="submit()">
          {{ submitLabel }}<template #icon><ArrowRight :size="16" /></template>
        </n-button>

        <div v-if="step === 'login'" class="auth-switch">
          <template v-if="registrationEnabled">
            <span>还没有账号？</span>
            <button type="button" :disabled="busy" @click="toStep('register')">立即注册</button>
          </template>
          <span v-else>没有账号或忘记密码？请联系管理员。</span>
        </div>
        <div v-else class="auth-switch">
          <button type="button" class="back" :disabled="busy" @click="backToLogin">
            <ArrowLeft :size="13" />{{step==='password'?'退出并更换账号':'返回登录'}}
          </button>
        </div>

      </div>
    </section>
  </div>
  <BehaviorCaptchaModal :show="captchaOpen" purpose="login" @cancel="captchaOpen=false" @verified="verified" />
</template>

<style scoped>
.email-code{display:flex;gap:8px;width:100%;min-width:0}.email-code .n-input{flex:1;min-width:0}
.auth-feedback{margin-bottom:18px}.password-guide{color:var(--text-secondary);font-size:12px;line-height:1.7;margin:0 0 16px}
.auth {
  position: relative;
  flex: 1 1 auto;
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(0, 1.05fr) minmax(0, 1fr);
  overflow: auto;
  /* 整页唯一底色：两栏都透明，因此左右必然一致 */
  background: var(--auth-bg);
  /* 登录页局部主题变量：浅色主题只需在下方覆盖这一组，
     避免为每个元素重复写一遍 .theme-light 规则 */
  --auth-bg: var(--bg);
  --auth-strong: var(--text-primary);
  --auth-text: var(--text-secondary);
  --auth-dim: var(--text-muted);
  --auth-accent: var(--accent);
  --auth-accent-hover: var(--accent-hover);
  --auth-accent-border: rgba(var(--accent-rgb), 0.3);
  --auth-accent-bg: rgba(var(--accent-rgb), 0.07);
  --auth-hairline: rgba(255, 255, 255, 0.07);
}

/* ── 左栏 ── */
.auth-aside {
  position: relative;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  padding: 44px 48px;
  overflow: hidden;
  /* 品牌栏与表单沿用同一主题底色。 */
  background: transparent;
  z-index: 1;
}
.aside-top,
.aside-body,
.aside-foot {
  position: relative;
  z-index: 1;
}
.aside-top {
  display: flex;
  align-items: center;
  gap: 12px;
}
.aside-mark {
  width: 38px;
  height: 38px;
  display: grid;
  place-items: center;
  border: 1px solid var(--auth-accent-border);
  border-radius: 10px;
  color: var(--auth-accent);
  background: var(--auth-accent-bg);
}
.aside-brand b {
  display: block;
  font-size: 14px;
  letter-spacing: 2.5px;
  color: var(--auth-strong);
}
.aside-brand span {
  display: block;
  font: 500 10px ui-monospace, Consolas, monospace;
  letter-spacing: 3.6px;
  color: var(--auth-dim);
}
.aside-body h2 {
  margin: 0 0 14px;
  font-size: 30px;
  line-height: 1.32;
  font-weight: 600;
  letter-spacing: 0.01em;
  color: var(--auth-strong);
}
.aside-body p {
  margin: 0 0 26px;
  max-width: 34ch;
  font-size: 13px;
  line-height: 1.7;
  color: var(--auth-text);
}
.aside-points {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.aside-points li {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 12.5px;
  color: var(--auth-text);
}
.aside-points i {
  flex: none;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--auth-accent);
  box-shadow: 0 0 0 4px var(--auth-accent-bg);
}
.aside-foot span {
  font: 500 9.5px ui-monospace, Consolas, monospace;
  letter-spacing: 4px;
  color: var(--auth-dim);
}

/* ── 右栏 ── */
.auth-main {
  display: grid;
  place-items: center;
  padding: 40px 32px;
  background: transparent;
  z-index: 1;
}
.auth-card {
  width: min(390px, 100%);
  display: flex;
  flex-direction: column;
}
.auth-head {
  display: flex;
  align-items: flex-start;
  gap: 14px;
  margin-bottom: 26px;
}
.auth-icon {
  flex: none;
  width: 40px;
  height: 40px;
  display: grid;
  place-items: center;
  border: 1px solid var(--auth-accent-border);
  border-radius: 11px;
  color: var(--auth-accent);
  background: var(--auth-accent-bg);
}
.auth-head h1 {
  margin: 0 0 5px;
  font-size: 21px;
  font-weight: 600;
  letter-spacing: 0.01em;
  color: var(--auth-strong);
}
.auth-head p {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--auth-text);
}
.auth-submit {
  margin-top: 6px;
}
.eye-btn {
  display: grid;
  place-items: center;
  border: 0;
  background: transparent;
  color: var(--auth-dim);
  cursor: pointer;
  transition: color 0.2s ease;
}
.eye-btn:hover {
  color: var(--auth-strong);
}
.auth-switch {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  margin-top: 16px;
  font-size: 12.5px;
  color: var(--auth-dim);
}
.auth-switch button {
  border: 0;
  background: transparent;
  padding: 0;
  color: var(--auth-accent);
  font-size: 12.5px;
  cursor: pointer;
  transition: color 0.2s ease;
}
.auth-switch button:hover {
  color: var(--auth-accent-hover);
  text-decoration: underline;
  text-underline-offset: 3px;
}
.auth-switch .back {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--auth-dim);
}
.auth-or {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 20px 0 14px;
  font-size: 11px;
  color: var(--auth-dim);
}
.auth-or:before,
.auth-or:after {
  content: "";
  flex: 1;
  height: 1px;
  background: var(--auth-hairline);
}
.auth-note {
  margin: 12px 0 0;
  font-size: 11px;
  line-height: 1.6;
  text-align: center;
  color: var(--auth-dim);
}

/* ── 浅色主题：文字变量直接引用全局变量自动适配，仅需覆盖发丝线 ── */
.theme-light .auth {
  --auth-hairline: rgba(0, 0, 0, 0.1);
}

/* 窄窗口：隐藏品牌栏，表单占满 */
@media (max-width: 860px) {
  .auth {
    grid-template-columns: 1fr;
  }
  .auth-aside {
    display: none;
  }
  .auth-main {
    padding: 28px 20px;
  }
}
</style>
