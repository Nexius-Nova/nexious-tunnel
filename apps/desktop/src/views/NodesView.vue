<script setup lang="ts">
import { ref } from "vue";
import { useMutation, useQuery, useQueryClient } from "@tanstack/vue-query";
import { NButton, NPopconfirm, NTag, useMessage } from "naive-ui";
import { Globe2, Pencil, Plus, Trash2 } from "lucide-vue-next";
import { api } from "../api/client";
import type { NodeInfo, NodeInput } from "../types";
import PageHeader from "../components/PageHeader.vue";
import StateBlock from "../components/StateBlock.vue";
import NodeDrawer from "../components/NodeDrawer.vue";

const queryClient = useQueryClient(),
  message = useMessage(),
  drawer = ref(false),
  editing = ref<NodeInfo | null>(null);
const query = useQuery({ queryKey: ["nodes"], queryFn: api.nodes });
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
              >{{ node.status === "online" ? "在线" : "维护中" }}</n-tag
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
      </article>
    </section>
    <NodeDrawer
      :show="drawer"
      :node="editing"
      :loading="save.isPending.value"
      @close="drawer = false"
      @submit="save.mutate"
    />
  </div>
</template>
