<script setup lang="ts">
defineProps<{ eyebrow: string; title: string; description: string }>()
</script>
<template><header class="page-header"><div><span class="eyebrow">{{eyebrow}}</span><h1>{{title}}</h1><p>{{description}}</p></div><div class="header-actions"><slot/></div></header></template>
