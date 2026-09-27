import { ref } from "vue";

// 会话 token 单独成模块，供 api/client 与 session 共用，
// 避免两者互相 import 形成循环依赖。
export const sessionToken = ref<string>("");
export const sessionEndpoint = ref<string>("");
