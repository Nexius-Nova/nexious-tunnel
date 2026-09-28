# 控制中心部署指南（Docker Compose + MySQL 8）

把控制中心服务端（`apps/server`）与 MySQL 8 部署到一台 Linux 服务器，
桌面客户端（Tauri）在登录页填写 `https://你的域名` 即可接入。

架构：`公网 → Caddy（80/443，自动 HTTPS）→ 控制中心（127.0.0.1:8787）→ MySQL（内部网络）`
源站与数据库均不直接暴露公网。

## 1. 服务器准备

- 一台 Linux 服务器（2C4G 起步），已安装 Docker 与 Docker Compose 插件：
  ```bash
  curl -fsSL https://get.docker.com | sh
  ```
- 域名一条 A/AAAA 记录指向服务器 IP（如 `nexious.example.com`）。
- 防火墙/安全组放行 `80`、`443`；**不要**放行 `8787` 与 `3306`。

## 2. 配置

```bash
git clone https://github.com/Nexius-Nova/nexious-tunnel.git
cd nexious-tunnel/deploy

cp .env.production.example .env
cp Caddyfile.example Caddyfile
```

编辑 `.env`，必填项：

| 变量 | 说明 |
| --- | --- |
| `NEXIOUS_MYSQL_PASSWORD` / `MYSQL_ROOT_PASSWORD` | 数据库密码，`openssl rand -base64 24` |
| `NEXIOUS_ADMIN_TOKEN` | 机器间同步令牌（等价管理员），`openssl rand -hex 32` |
| `NEXIOUS_BOOTSTRAP_ADMIN_PASSWORD` | 初始管理员密码（空库首次启动必须，登录后强制改密） |
| `NEXIOUS_PUBLIC_HOST` | 控制中心公网域名 |
| `NEXIOUS_ALLOWED_ORIGINS` | 把示例域名换成你的 |

编辑 `Caddyfile`，把 `nexious.example.com` 替换为你的域名。

可选：配置 `RESEND_API_KEY`（注册邮箱验证码）与 `ALIPAY_*`（付费套餐）。

## 3. 启动与验证

```bash
docker compose up -d --build
docker compose ps                 # 三个服务应为 healthy/running
curl -s https://你的域名/api/health   # {"ok":true,...}
```

首次登录：用户名 `NEXIOUS_BOOTSTRAP_ADMIN`（默认 `admin`），系统会强制修改密码。
成功后把 `.env` 里的 `NEXIOUS_BOOTSTRAP_ADMIN_PASSWORD` 清空（仅首次启动读取）。

## 4. 日常运维

```bash
# 查看日志
docker compose logs -f server

# 升级版本
git pull && docker compose up -d --build

# 备份数据库（建议 cron 每日执行）
docker compose exec mysql sh -c \
  'mysqldump -uroot -p"$MYSQL_ROOT_PASSWORD" --single-transaction "$MYSQL_DATABASE"' \
  > backup-$(date +%F).sql

# 恢复备份
cat backup-2026-09-28.sql | docker compose exec -T mysql sh -c \
  'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" "$MYSQL_DATABASE"'
```

## 5. 安全清单

- [ ] `.env` 权限收紧：`chmod 600 .env`；永不提交到仓库
- [ ] `NEXIOUS_ADMIN_TOKEN` 未泄露给普通用户（等价管理员）
- [ ] `NEXIOUS_ALLOWED_ORIGINS` 只包含真实来源，无 `*`
- [ ] 服务器防火墙只开放 80/443
- [ ] 支付宝公钥 `ALIPAY_PUBLIC_KEY` 已配置（对异步通知验签）
- [ ] 定时备份已生效并异地保存一份
- [ ] `docker compose exec server env` 中无意外密钥残留

## 6. 常见问题

- **80/443 被占用**：若服务器已有 Nginx/面板，去掉 compose 中的 `caddy` 服务，
  在现有反代中把域名代理到 `http://127.0.0.1:8787`，并保留原始 Host、开启 WebSocket。
- **节点部署的节点机器**：与本指南无关。边缘节点由桌面端「节点部署」通过 SSH 自动安装，
  不需要 Docker。
- **健康检查失败**：`docker compose logs server` 常见原因是 `.env` 中
  `NEXIOUS_MYSQL_PASSWORD` 与首次初始化时不一致——改密码需重建 `mysql-data` 卷。
