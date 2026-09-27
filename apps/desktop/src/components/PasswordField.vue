<script setup lang="ts">
import { computed } from "vue";
import { NInput } from "naive-ui";
import { passwordIssue } from "../accountValidation";
const props = withDefaults(defineProps<{value:string;disabled?:boolean;placeholder?:string;label?:string;size?:"small"|"medium"|"large"}>(), {label:"新密码",placeholder:"至少 8 位，最多 128 位",size:"medium"});
const emit = defineEmits<{"update:value":[value:string];enter:[]}>();
const issue = computed(() => props.value ? passwordIssue(props.value) : null);
</script>
<template>
  <div class="password-field">
    <n-input :value="value" type="password" show-password-on="click" :disabled="disabled" :size="size" :maxlength="128" :placeholder="placeholder" :input-props="{autocomplete:'new-password','aria-label':label}" @update:value="emit('update:value',$event)" @keyup.enter="emit('enter')" />
    <span class="password-hint" :class="{invalid:issue}" aria-live="polite">{{issue || (value ? '长度符合要求，请使用独立于其他网站的密码。' : '建议使用长密码或密码短语，允许空格与中文。')}}</span>
  </div>
</template>
<style scoped>
.password-field{width:100%}.password-hint{display:block;margin-top:7px;color:var(--text-muted);font-size:12px;line-height:1.6}.password-hint.invalid{color:#d97171}
</style>
