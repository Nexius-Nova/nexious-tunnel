<script setup lang="ts">
import { reactive, ref, watch } from "vue";
import {
  NButton,
  NModal,
  NForm,
  NFormItem,
  NInput,
  NSpace,
  type FormInst,
  type FormRules
} from "naive-ui";
import type { NodeInfo, NodeInput } from "../types";

const props = defineProps<{
  show: boolean;
  node: NodeInfo | null;
  loading: boolean;
}>();
const emit = defineEmits<{ close: []; submit: [value: NodeInput] }>();
const formRef = ref<FormInst | null>(null);
const form = reactive<NodeInput>({ name: "", host: "" });
watch(
  () => [props.show, props.node] as const,
  () => {
    if (props.show)
      Object.assign(
        form,
        props.node
          ? { name: props.node.name, host: props.node.host }
          : { name: "", host: "" }
      );
  },
  { immediate: true }
);
const rules: FormRules = {
  name: { required: true, min: 2, message: "请输入至少 2 个字符的名称", trigger: "blur" },
  host: { required: true, min: 3, message: "请输入节点域名", trigger: "blur" }
};
async function submit() {
  await formRef.value?.validate();
  emit("submit", { ...form });
}
</script>

<template>
  <n-modal :show="show" preset="card" :title="node ? '编辑边缘节点' : '添加边缘节点'" :style="{ width: '460px' }" :mask-closable="false" @close="emit('close')">
    <div class="modal-intro"><b>{{ node ? "更新节点信息" : "添加中转节点" }}</b><span>节点域名用于生成子域名访问地址。</span></div>
    <n-form ref="formRef" :model="form" :rules="rules" label-placement="top">
      <n-form-item label="节点名称" path="name"><n-input v-model:value="form.name" placeholder="例如：主节点" /></n-form-item>
      <n-form-item label="节点域名" path="host"><n-input v-model:value="form.host" placeholder="tunnel.example.com" /></n-form-item>
    </n-form>
    <template #action>
      <n-space justify="end"><n-button @click="emit('close')">取消</n-button><n-button type="primary" :loading="loading" @click="submit">保存节点</n-button></n-space>
    </template>
  </n-modal>
</template>
<style scoped>
.modal-intro{margin-bottom:16px;display:flex;flex-direction:column;gap:4px}
.modal-intro b{font-size:14px}
.modal-intro span{font-size:12px;color:var(--text-secondary)}
</style>
