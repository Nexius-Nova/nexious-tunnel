<script setup lang="ts">
import { ref } from "vue";
import { useMutation, useQuery, useQueryClient } from "@tanstack/vue-query";
import { NButton, NPopconfirm, NTag, useMessage } from "naive-ui";
import { Copy, Eye, EyeOff, Globe2, Pencil, Plus, ServerCog, Trash2 } from "lucide-vue-next";
import { api } from "../api/client";
import type { NodeInfo, NodeInput } from "../types";
import PageHeader from "../components/PageHeader.vue";
import StateBlock from "../components/StateBlock.vue";
import NodeDrawer from "../components/NodeDrawer.vue";
import NodeDeployModal from "../components/NodeDeployModal.vue";

const queryClient = useQueryClient(),
  message = useMessage(),
  drawer = ref(false),
  editing = ref<NodeInfo | null>(null);
const deploying=ref<NodeInfo|null>(null);
const visibleTokens=ref(new Set<string>());
const query = useQuery({ queryKey: ["nodes"], queryFn: api.nodes, refetchInterval:15_000 });
const refresh = () => {
  queryClient.invalidateQueries({ queryKey: ["nodes"] });
  queryClient.invalidateQueries({ queryKey: ["dashboard"] });
  queryClient.invalidateQueries({ queryKey: ["tunnels"] });
};
const save = useMutation({
  mutationFn: (value: NodeInput) =>
    editing.value
      ? api.updateNode(editing.value.id, value)
      : api.createNode(value),
  onSuccess: () => {
    message.success(editing.value ? "节点已更新" : "节点已添加");
    drawer.value = false;
    refresh();
  },
  onError: (error) => message.error(error.message)
});
const remove = useMutation({
  mutationFn: api.deleteNode,
  onSuccess: () => {
    message.success("节点已删除");
    refresh();
  },
  onError: (error) => message.error(error.message)
});
function open(node: NodeInfo | null = null) {
  editing.value = node;
  drawer.value = true;
}
function toggleToken(id:string){const next=new Set(visibleTokens.value);next.has(id)?next.delete(id):next.add(id);visibleTokens.value=next}
async function copy(value:string|null,label:string){if(!value)return;await navigator.clipboard.writeText(value);message.success(`${label}已复制`)}
</script>

<template>
  <div class="view">
    <PageHeader
      eyebrow="EDGE NETWORK"
      title="边缘节点"
      description="管理用于承载公网流量的中转服务器。"
      ><n-button type="primary" @click="open()"
        ><template #icon><Plus /></template>添加节点</n-button
      ></PageHeader
    ><StateBlock
      v-if="query.isLoading.value || query.error.value"
      :loading="query.isLoading.value"
      :error="query.error.value?.message"
    />
    <section v-else class="node-grid">
      <article
        v-for="node in query.data.value"
        :key="node.id"
        class="node-card"
      >
        <div class="node-top">
          <div class="node-pin"><Globe2 /></div>
          <div class="node-actions">
            <n-tag
              :type="node.status === 'online' ? 'success' : 'warning'"
              :bordered="false"
              size="small"
              >{{ node.status === "online" ? "在线" : "离线" }}</n-tag
            ><n-button
              quaternary
              circle
              size="small"
              title="编辑节点"
              @click="open(node)"
              ><Pencil :size="15" /></n-button
            ><n-popconfirm @positive-click="remove.mutate(node.id)"
              ><template #trigger
                ><n-button quaternary circle size="small" title="删除节点"
                  ><Trash2 :size="15" /></n-button></template
              >确认删除节点"{{ node.name }}"？</n-popconfirm
            >
          </div>
        </div>
        <span>RELAY NODE</span>
        <h2>{{ node.name }}</h2>
        <p class="node-host"><Globe2 :size="14" />{{ node.host }}</p>
        <div class="node-divider"></div>
        <div class="controller-state"><div><span>独立控制中心</span><b>{{node.deploy_status==='ready'?'已连接':node.deploy_status==='error'?'配置异常':'未配置'}}</b></div><i :class="node.deploy_status"></i></div>
        <dl class="node-meta"><div><dt>SSH 连接</dt><dd>{{node.ssh_user&&node.server_host?`${node.ssh_user}@${node.server_host}:${node.ssh_port}`:'尚未关联'}}</dd></div><div><dt>控制中心 API</dt><dd>{{node.controller_url||'部署后自动获取'}}</dd><n-button v-if="node.controller_url" text title="复制控制中心 API" @click="copy(node.controller_url,'API 地址')"><Copy :size="14"/></n-button></div><div><dt>节点 Token</dt><dd>{{node.controller_token?(visibleTokens.has(node.id)?node.controller_token:'••••••••••••••••'):'部署后自动获取'}}</dd><span v-if="node.controller_token" class="meta-actions"><n-button text :title="visibleTokens.has(node.id)?'隐藏 Token':'显示 Token'" @click="toggleToken(node.id)"><EyeOff v-if="visibleTokens.has(node.id)" :size="14"/><Eye v-else :size="14"/></n-button><n-button text title="复制节点 Token" @click="copy(node.controller_token,'节点 Token')"><Copy :size="14"/></n-button></span></div><div><dt>最近检查</dt><dd>{{node.last_checked_at?new Date(node.last_checked_at).toLocaleString('zh-CN'):'尚未检查'}}</dd></div></dl>
        <p v-if="node.last_error" class="node-error">{{node.last_error}}</p>
        <n-button block :type="node.deploy_status==='ready'?'default':'primary'" @click="deploying=node"><template #icon><ServerCog/></template>{{node.deploy_status==='ready'?'检查 / 重新配置':'配置服务器'}}</n-button>
      </article>
    </section>
    <NodeDrawer
      :show="drawer"
      :node="editing"
      :loading="save.isPending.value"
      @close="drawer = false"
      @submit="save.mutate"
    />
    <NodeDeployModal :show="Boolean(deploying)" :node="deploying" @close="deploying=null" @complete="refresh"/>
  </div>
</template>
<style scoped>
.node-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(310px,1fr));gap:14px}.node-card{border:1px solid var(--border-color);background:var(--surface);padding:18px;min-width:0}.node-top,.node-actions,.controller-state{display:flex;align-items:center;justify-content:space-between}.node-pin{width:38px;height:38px;display:grid;place-items:center;border:1px solid var(--border-color);color:var(--accent)}.node-actions{gap:3px}.node-card>span{display:block;margin-top:18px;color:var(--text-secondary);font:600 10px "IBM Plex Mono";letter-spacing:2px}.node-card h2{font-size:20px;margin:5px 0 8px}.node-host{display:flex;align-items:center;gap:7px;color:var(--text-secondary);margin:0}.node-divider{height:1px;background:var(--border-color);margin:18px 0}.controller-state span,.node-meta dt{font-size:11px;color:var(--text-secondary)}.controller-state div{display:flex;flex-direction:column;gap:2px}.controller-state i{width:9px;height:9px;border-radius:50%;background:#a4aaa7}.controller-state i.ready{background:#28c780}.controller-state i.error{background:#e35d6a}.node-meta{display:flex;flex-direction:column;gap:10px;margin:16px 0}.node-meta div{display:grid;grid-template-columns:90px minmax(0,1fr) auto;align-items:center;gap:8px}.node-meta dd{margin:0;font:500 11px "IBM Plex Mono";overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.meta-actions{display:flex;align-items:center;gap:8px}.node-error{font-size:12px;color:#d84e5e;padding:8px;background:rgba(216,78,94,.08);overflow-wrap:anywhere}@media(max-width:560px){.node-grid{grid-template-columns:1fr}.node-card{padding:15px}.node-meta div{grid-template-columns:82px minmax(0,1fr) auto}}
:global(.theme-light) .node-card{background:#fff;border-color:#d8dedb;box-shadow:0 2px 8px rgba(20,32,26,.04)}
:global(.theme-light) .node-card:hover{border-color:#c5d0ca;box-shadow:0 4px 14px rgba(20,32,26,.08)}
:global(.theme-light) .node-pin{background:#edf7f1;border-color:#b9d8c7}
:global(.theme-light) .node-actions .n-button{color:#52605a}
:global(.theme-light) .node-actions .n-button:hover{color:#239b61}
:global(.theme-light) .node-host{color:#68736e}
:global(.theme-light) .node-divider{background:#e1e6e3}
:global(.theme-light) .controller-state span,:global(.theme-light) .node-meta dt{color:#68736e}
:global(.theme-light) .node-meta dd{color:#26332d}
:global(.theme-light) .node-error{color:#b83243;background:#fff1f2}
</style>
