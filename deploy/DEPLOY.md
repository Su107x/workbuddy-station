# 部署说明（服务器版）

本包是 **WorkBuddy 多账号工作台** 的服务端。零第三方运行时依赖（业务代码只用 Node 标准库），
唯一依赖 `playwright-core` 用于扫码登录时拉起浏览器。

---

## 0. 包内容

```
jwd-server-<时间戳>/
├── server.js            # 入口
├── lib/                 # 业务模块（账号 / 鉴权 / 小喵 / 调度 / 上游接口）
├── public/              # 前端页面（单文件，含全部 UI）
├── extension/           # 浏览器扩展（抓 Cookie 用，可选）
├── deploy/              # systemd unit + nginx 配置
├── tools/               # 自检与诊断脚本
├── Dockerfile           # 容器构建
├── docker-compose.yml   # 容器编排
├── .env.example         # 环境变量样例
├── DEPLOY.md            # 本文件
└── README.md            # 完整功能文档
```

`data/` **不在包里**（里面是加密的账号库），首次启动自动生成。

---

## 0. 关于 Node 的安装方式（运维必读）

Ubuntu 仓库里的 `nodejs` 版本滞后（26.04 长期停在 22.22.1，含 CVE-2026-111497 Brotli2Shell）。
因此本服务**使用官方二进制，安装在 `/opt/node`**，`apt upgrade` 不会更新它。

systemd 单元固定为：

```
ExecStart=/opt/node/bin/node /opt/jwd-server/server.js
```

升级 Node 的正确姿势（改版本号即可，不要改回 `/usr/bin/node`）：

```bash
VER=22.23.4
curl -fsSL "https://nodejs.org/dist/v$VER/node-v$VER-linux-x64.tar.xz" -o /tmp/n.tar.xz
tar -xJf /tmp/n.tar.xz -C /opt/node --strip-components=1
systemctl restart jwd
/opt/node/bin/node -v
```

安全评估与加固记录见 `deploy/SECURITY-REPORT-2026-10-29.md`。

---

## 1. 服务器选型（部署前必读）

本服务很轻，**但要跑扫码登录就得拉无头 Chromium**，内存是唯一的硬门槛。

### 结论先说

| 你的配置 | 能跑吗 | 说明 |
|---|---|---|
| **2 核 2G + Windows 10 + 30G 系统盘** | ❌ **强烈不建议** | Win10 空载就吃掉 **1.3GB / 2GB（65%）**，只剩约 700MB。再放 Node（~100MB）+ Chromium（Windows 上常驻 300~500MB）必然顶满，接着就开始往 30G 机械盘上换页，会卡到远程桌面都进不去。 |
| **2 核 2G + Linux** | ✅ **可以** | Linux 空载 150~250MB。系统 + Node + Chromium 峰值约 700MB，还剩一半余量。 |
| 2 核 4G 及以上 | ✅ 宽松 | 随意。 |

**所以：这台腾讯云请重装成 Linux。** 腾讯云控制台 → 实例 →「重装系统」→ 公共镜像选
**Ubuntu 22.04 LTS 64位**（或 Debian 12 / OpenCloudOS 9），重装本身不额外收费。
腾讯云的 Windows 镜像是按量额外收镜像费的，换 Linux 反而更省钱。

### 为什么 Windows 那台不行（实测数据）

| 资源 | Win10 实测 | 项目还要占 | 结果 |
|---|---|---|---|
| 内存 | 1.3 / 2.0 GB 已用 65%（纯系统空载） | Node ~100MB + Chromium 300~500MB | 必然 OOM / 疯狂换页 |
| 系统盘 | Win10 本身 16~20GB，加更新与 WinSxS 25GB+ | Chromium ~500MB、Node ~100MB | 30G 所剩无几，且 pagefile 还要 2~4GB |
| 磁盘类型 | HDD | — | 一旦开始换页就是雪崩，IO 直接打满 |

顺带一提，Windows 版的唯一优势是能直接复用系统自带的 Edge（不用另外下 Chromium），
但这点磁盘节省救不了内存。

### Linux 上的内存账（2G 机器实测推算）

```
系统空载（Ubuntu 22.04 minimal）  ~200 MB
jwd-server（Node 单进程）         ~100 MB
Chromium 无头（仅扫码登录时）     ~250~350 MB
------------------------------------------------
峰值                              ~650 MB / 2048 MB
```

### 2G 机器必做的三件事

1. **加 swap（必做）** —— 2G 物理内存没有 swap，峰值一来直接 OOM kill：

   ```bash
   fallocate -l 2G /swapfile && chmod 600 /swapfile
   mkswap /swapfile && swapon /swapfile
   echo '/swapfile none swap sw 0 0' >> /etc/fstab
   ```

2. **浏览器空闲自动关闭（已内置）** —— Chromium 跨扫码任务复用，不关就永久常驻。
   现已改成无活跃任务后空闲 **10 分钟**自动关闭，下次扫码再拉起（多等 1~2 秒）。
   用 `WB_BROWSER_IDLE_MINUTES` 调整，设 `0` 退回「永不关闭」。

3. **用 Docker 并限内存** —— 放开 `docker-compose.yml` 里那两行注释：

   ```yaml
   mem_limit: 768m
   memswap_limit: 768m
   ```

   这样浏览器再怎么吃也拖不垮系统本身。

---

## 2. 环境要求

| 项 | 要求 |
|---|---|
| 操作系统 | **Linux（Ubuntu 22.04 / Debian 12 等）**，不要 Windows —— 见上一节 |
| Node.js | ≥ 18（推荐 20/22） |
| Chromium | **扫码登录需要**（手机号登录也复用同一个浏览器实例），Debian/Ubuntu：`apt install -y chromium` |
| 内存 | **≥ 2GB**（系统 ~200MB + 服务 ~100MB + 浏览器峰值 ~350MB）；低于 2G 必须配 swap |
| swap | 2G 及以下机器**必配** 1~2GB，否则浏览器峰值会触发 OOM kill |
| 磁盘 | ≥ 10GB（系统 ~4GB + Chromium ~500MB + 日志，数据只有几十 KB） |
| 端口 | 8790（只监听回环，由 Nginx 反代对外） |
| 时区 | `TZ=Asia/Shanghai`（签到定时、每日上限都按本地日期算） |

服务器需要能出网访问 `www.workbuddy.cn`、`acc-*.myqcloud.com`、`openplatform-cdn.codebuddy.cn`。

中小内存机器装完先加 swap（命令见上一节第 1 条），再启动服务。

---

## 3. 方案 A：Docker（推荐）

```bash
# 2.1 上传解压
tar -xzf jwd-server-<时间戳>.tar.gz && cd jwd-server-<时间戳>

# 2.2 生成 .env
cp .env.example .env
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # 贴进 WB_MASTER_KEY
vim .env    # 至少改 WB_ADMIN_PASSWORD 和 WB_MASTER_KEY

# 2.3 起服务
docker compose up -d --build
docker compose logs -f          # 首次启动会打印初始口令（若 .env 里没设）
```

> **主密钥必须自己固定**（`WB_MASTER_KEY`）。留空的话会随机生成到 `data/master.key`，
> 容器一删数据就解不开 —— 迁移和备份时务必把这个值单独存好。

反向代理（`deploy/nginx.conf` 已备好，改域名即可）：

```bash
cp deploy/nginx.conf /etc/nginx/conf.d/jwd.conf
# 改 server_name 与证书路径
certbot --nginx -d wb.example.com
nginx -t && systemctl reload nginx
```

---

## 4. 方案 B：systemd 裸机

```bash
# 3.1 依赖
apt update && apt install -y nodejs npm chromium fonts-noto-cjk fontconfig ca-certificates

# 3.2 放代码
mkdir -p /opt/jwd-server && tar -xzf jwd-server-<时间戳>.tar.gz -C /opt/jwd-server --strip-components=1
cd /opt/jwd-server && npm ci --omit=dev

# 3.3 运行账号与目录权限
useradd -r -s /usr/sbin/nologin jwd || true
mkdir -p /opt/jwd-server/data && chown -R jwd:jwd /opt/jwd-server
chmod 600 /opt/jwd-server/data

# 3.4 环境变量
cp .env.example .env && vim .env   # 填 WB_ADMIN_PASSWORD / WB_MASTER_KEY
chown jwd:jwd .env && chmod 600 .env

# 3.5 systemd
cp deploy/jwd.service /etc/systemd/system/jwd.service
# 确认 unit 里的 WorkingDirectory / ExecStart / ReadWritePaths 与实际路径一致
systemctl daemon-reload && systemctl enable --now jwd
journalctl -u jwd -f
```

裸机版需要在 `.env` 里额外加一行，让扫码登录找到系统 Chromium：

```
WB_CHROMIUM_PATH=/usr/bin/chromium
```

---

## 5. 数据迁移（把本机的账号搬到服务器）

本机生成的 `data/db.enc` 是**整库加密**的密文，配套 `data/master.key` 是主密钥。
两个文件一起拷过去，服务器上原样放好即可，账号、Cookie、令牌、设置全部保留。

```bash
# 在本机（打包脚本已附带 jwd-data-<时间戳>.tar.gz）
tar -xzf jwd-data-<时间戳>.tar.gz

# 在服务器
tar -xzf jwd-data-<时间戳>.tar.gz -C /opt/jwd-server
chown -R jwd:jwd /opt/jwd-server/data && chmod 600 /opt/jwd-server/data/*
# 或者用 docker：把 data/ 挂到 /opt/jwd-server/data
```

> 如果服务器 `.env` 里设了 `WB_MASTER_KEY`，它必须和本机 `data/master.key` 一致，
> 否则密文解不开（表现为「账号列表为空」）。
> 想换主密钥就得用旧密钥解开再用新密钥重写，不要直接改。

**不建议**直接把本机的 `data/` 放进源码包 —— 主密钥会跟着公开流传。

---

## 6. 上线自检清单

```bash
curl -s http://127.0.0.1:8790/api/session          # 应返回 200
curl -sI http://127.0.0.1:8790/                     # 首页 200
```

浏览器打开后按顺序确认：

1. **登录**：首次用 `.env` 里的 `WB_ADMIN_PASSWORD` 登录，登录后立刻改口令。
2. **账号**：账号列表能看到迁移过来的账号，`有凭证` 一栏不是「缺凭证」。
3. **签到**：账号页点「立即签到」能拿到积分（需要 Bearer 令牌，纯 Cookie 账号走计费接口可能不通）。
4. **小喵**：小喵页能看到状态卡；点「查看可选地点」应返回 4 个地点、id 为 `1/2/3/4`
   （若显示成 `coffee/mall/...` 就是旧版本，先升级）。
5. **自动领取**：小喵页「回来自动领积分」默认开启，巡检每 5 分钟跑一次；
   猫到点后状态卡会自动变回「空闲」，「今日已领取」计数 +1。
   想要空闲时也自动派出，再打开「自动巡检」开关（每天只能派一次）。

---

## 7. 定时任务说明

服务内置定时器（单进程，30 秒一 tick），不需要 crontab：

| 任务 | 开关 | 默认 |
|---|---|---|
| 自动签到 | `settings.checkin.autoEnabled` | 关 |
| 自动刷新额度 | `settings.quota.autoRefreshMinutes` | 30 分钟 |
| 自动巡检（派+领） | `settings.meow.enabled` | 关 |
| **回来自动领积分** | `settings.meow.autoClaim` | **开** |

重启不丢当天进度（所有状态落库）。

---

## 8. 常见问题

**页面能开但接口都报「未登录或会话已过期」**
反向代理没带 Cookie，或 `Host` 头被改写。检查 nginx 的 `proxy_set_header Host $host;`。

**扫码登录报「找不到 Chromium」**
裸机装 `chromium` 并在 `.env` 里设 `WB_CHROMIUM_PATH=/usr/bin/chromium`；
Docker 镜像里已装好，不用管。

**容器起来就退出**
`docker compose logs` 看报错。最常见是 `data/` 权限不对（容器内用 `node` 用户，需要可写）。

**升级后账号全没了**
主密钥变了。`.env` 里的 `WB_MASTER_KEY` 必须和建库时一致。

**小喵一直「旅行中」不领取**
巡检默认 5 分钟一次；页面右下「下次巡检」能看到倒计时。也可以点「刷新状态」手动触发。

**内存越用越多 / 服务莫名被杀**
扫码登录拉起的 Chromium 以前是常驻的。现在默认空闲 10 分钟自动关闭，
确认 `.env`（或 compose）里 `WB_BROWSER_IDLE_MINUTES` 没被设成 `0`。
2G 机器另外配好 swap、并按第 1 节给 Docker 加 `mem_limit`。

**扫码登录第一次很慢**
浏览器冷启动 + 加载登录页，正常 3~8 秒。这是「空闲自动关闭」换来的代价，
想让它一直热着就把 `WB_BROWSER_IDLE_MINUTES` 设成 `0`（内存够的话）。

**想确认内存够不够**
```bash
free -h                       # 看剩余内存与 swap
ps -o rss,cmd -C node         # 服务常驻占用
docker stats --no-stream      # Docker 部署看容器实际用量
```
