# 控制中心服务端镜像。
# 多阶段构建：构建层安装 pnpm 工作区依赖（含 better-sqlite3 可选依赖的本地编译工具），
# 运行层为干净的 node:24-slim，以非 root 用户运行。
FROM node:24-slim AS build
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/
# better-sqlite3 是可选依赖：预编译产物缺失时需要 node-gyp 本地编译。
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/* \
 && pnpm install --frozen-lockfile --filter @nexious/server
COPY apps/server apps/server

FROM node:24-slim
WORKDIR /app/apps/server
COPY --from=build --chown=node:node /app /app
ENV NODE_ENV=production \
    PORT=8787 \
    BIND_HOST=0.0.0.0
USER node
EXPOSE 8787
# 与 apps/server/package.json 的 start 脚本一致：tsx 直接运行 TS 源码。
CMD ["node", "--import", "tsx", "src/index.ts"]
