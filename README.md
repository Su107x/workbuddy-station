# WorkBuddy 多账号工作台 · 服务端

把多个 WorkBuddy 账号的**额度、签到、模型调用**集中到一个网页控制台，并对外提供一个
**OpenAI 兼容的反向代理**，让 Claude Code、opencode、任何 OpenAI SDK 都能直接复用你已有的账号额度。

- 零第三方依赖，只需要 Node 18+，`node server.js` 就能跑
- 为**公网服务器**设计：登录口令、会话票据、CSRF、登录限流、整库加密、Docker / systemd / Nginx 部署模板齐备
- 页面、API、反向代理同一个端口，反代链路内置 SSE 流式透传

---

## 一、先说清楚：原文章里「必须本地才能做」的四件事，这里怎么落地

参考文章里的桌面软件有四个能力，纯网页做不到。本项目换了个实现位置 —— 不再依赖「本机进程」，
而是把服务放到服务器上，把凭证获取交给浏览器：

| 能力 | 桌面软件的做法 | 本项目的做法 |
|---|---|---|
| 扫码授权抓凭证 | 内嵌 webview 抓 cookie | **浏览器扩展**在已登录的 workbuddy.cn 页面里读登录态，用官方接口自校验后回传到服务器 |
| 系统钥匙串 | 调用操作系统密钥库 | **服务端主密钥 + AES-256-GCM 整库加密**，`data/master.key` 权限 600 或由环境变量注入 |
| 本地反向代理 | 本机进程监听 127.0.0.1 | **服务器直接监听 `/v1`**，配置里填服务器地址即可，本来就不需要「本地」 |
| 定时签到 / 巡检 | 开机自启的本地服务 | **服务端常驻进程内定时器**，页面关了照常执行，重启不丢当天进度 |

这四处改动的共同点是：把「能力」从桌面搬到服务端，把「凭证入口」从进程抓取改成浏览器授权。
结果是它比原版更适合长期挂着 —— 服务器不关机，签到和代理就不会断。

---

## 二、快速开始

### 方式 A：本机跑起来（开发 / 试用）

```bash
cd jwd-server
node server.js
```

首次启动会打印一段管理员口令：

```
================================================================
  WorkBuddy 多账号工作台 · 服务端已启动
================================================================
  监听地址   0.0.0.0:8790
  本机访问   http://127.0.0.1:8790
  首次启动，管理员口令：xxxxxxxxxxxx
  请登录后立即在「设置」里修改口令。
```

也可以自己指定：`WB_ADMIN_PASSWORD=你的口令 node server.js`

### 方式 B：Docker（推荐）

```bash
cp .env.example .env
# 改 .env：至少填 WB_ADMIN_PASSWORD 和 WB_MASTER_KEY
docker compose up -d --build
docker compose logs -f
```

生成主密钥：

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

> **主密钥一定要固定并备份。** 数据文件 `data/db.enc` 用它加密，换了密钥旧数据就解不开。

### 方式 C：systemd（裸机常驻）

```bash
sudo mkdir -p /opt/jwd-server && sudo cp -r ./* /opt/jwd-server/
sudo useradd -r -s /usr/sbin/nologin jwd || true
sudo chown -R jwd:jwd /opt/jwd-server
sudo cp deploy/jwd.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now jwd
```

前面挂 Nginx（含 `/v1` 关闭缓冲的配置）：`deploy/nginx.conf`

---

## 三、把账号接进来

页面里三条路，**首选扫码**，其余作为兜底：

### 1. 扫码登录（推荐，一个号一次扫码，不用手抄任何东西）

`账号` → 点右上角「扫码登录」→ 弹出二维码 → 微信扫一下并在手机上确认 → 自动入库。

原理是服务端自己跑浏览器，不是让你去翻 F12：

```
POST /api/login/qr/start   → 服务端拉起无头 chromium，打开
                             https://www.workbuddy.cn/login/?platform=website&state=2&product=workbuddy
                             → Keycloak（client_id=console，scope 含 offline_access）
                             → 微信 IdP：open.weixin.qq.com/connect/qrconnect（微信开放平台 appid）
                             → 把二维码图片抓下来，data URL 回给前端
GET  /api/login/qr/{id}    → 每 2 秒轮询；服务端到业务页实打一次
                             /v2/billing/meter/checkin-activity-status 逼 APISIX 下发会话
                             → 登录成功后把整份 Cookie 收走、校验、入库
POST /api/login/qr/{id}/cancel → 关掉浏览器上下文
```

为什么不能手工复制 Cookie：网页版业务接口（`/v2/*`、`/activity/growth/*`）**不发 `Authorization`**，
全靠 APISIX 的 openid-connect 会话 Cookie；而浏览器里能看到的 `session` / `session_2` 是腾讯 SSO
的会话，不是 APISIX 的那一个。抓错 Cookie 的表现就是网关直接返回 APISIX 的 `401` HTML，
跟业务层无关，所以会被判成「令牌无效」。

要点：

- 同时最多 3 个扫码任务，每个任务一个独立浏览器上下文，互不干扰，串行扫多个号即可
- 二维码约 5 分钟有效，过期点「重新获取」；微信侧自动换码时前端也会跟着刷新
- 登录态 Cookie 会连同登录时用的 UA 一起存库，后续请求复用同一个 UA，避免绑定不一致
- 容器里需要 chromium：镜像已装好并设置 `WB_CHROMIUM_PATH=/usr/bin/chromium`；
  裸机部署时把该变量指向本机 chromium（Windows 开发机会自动回落到本机 Edge）

### 2. 浏览器扩展一键抓取

```
Chrome / Edge → 打开 chrome://extensions → 打开「开发者模式」
→「加载已解压的扩展程序」→ 选择本项目的 extension 目录
```

使用：

1. 在浏览器里正常登录 `https://www.workbuddy.cn`
2. 回到控制台「账号」页 → 点「配对码」→ 拿到 6 位数字（10 分钟有效，一次性）
3. 点扩展图标 → 填工作台地址 + 配对码 → 点「抓取并上报」

扩展会做四件事：在页面里用**当前登录态**同源请求一次签到状态、小喵状态、地点配置
（这次请求顺手验证了登录是否有效，结果也会记进服务端日志）→ 扫 localStorage / sessionStorage 找
`accessToken` 与 UID → 用 `chrome.cookies` 取回完整 Cookie（含 HttpOnly）→
把 token / cookie / uid / 探测结果一起回传。整个过程不上传密码。

只要浏览器登录着，**即使拿不到明文令牌也能用** —— 服务端会用同样的 Cookie 调通接口。

### 3. 手动粘贴 / 探测台

`账号` → `手动新增` → 填备注名、UID，再填「访问令牌」或「Cookie」其中之一。
提交时服务端会先调官方接口校验，不通过直接拒绝，不会把废凭证存进去。

「设置 → 接口探测台」可以选择一个已有账号作凭证来源，打任意路径并原样返回响应体，
用来验证接口契约、排查 401/403。

---

## 四、用反向代理复用额度

「代理」页开启后，得到两项：

```
Base URL   https://你的域名/v1
API Key    SK-xxxxxxxx
```

OpenAI SDK：

```python
from openai import OpenAI
client = OpenAI(base_url="https://你的域名/v1", api_key="SK-xxxxxxxx")
resp = client.chat.completions.create(model="default", messages=[{"role":"user","content":"你好"}])
```

环境变量（大多数 OpenAI 兼容客户端通用）：

```bash
export OPENAI_BASE_URL="https://你的域名/v1"
export OPENAI_API_KEY="SK-xxxxxxxx"
```

调度策略：

| 策略 | 行为 | 适用 |
|---|---|---|
| `balance` 余额优先 | 积分多的先用 | 默认，均衡消耗 |
| `roundrobin` 轮询 | 挨个轮 | 多账号平摊 |
| `drain` 集中消耗 | 先榨干积分少的 | 想清空小号 |

另外可设**粘性会话**（同一会话固定账号，命中上游缓存）和**失败换号上限**
（遇到 401/403/429/5xx 自动换下一个账号重试）。流式请求原样透传，不做二次封装。

模型名：填 `default` 即可，也可以填 `/v1/models` 返回的任意 id（内置 58 个，来自客户端产品配置）。

> **上游约束（已实测）**：`workbuddy.cn/v2/chat/completions` **只接受 `stream:true`**，
> 非流式请求会返回 `400 / code 11101`。
> 本项目在网关层做了双向适配：
> - 客户端要**流式** → 直接透传上游 SSE（逐字透传，不改帧）
> - 客户端要**非流式** → 网关读干上游 SSE，聚合为标准 `chat.completion`
>   （拼接 `content` / `reasoning_content`，按 index 合并 `tool_calls.arguments`）
>
> 所以任何 OpenAI 兼容客户端（流式或非流式）都能直接用。

### 在 WorkBuddy 桌面端里用（主账号挂工作台积分）

这是本项目的核心用法：**主 WorkBuddy 不切账号，把闲置账号的积分当自己的额度用。**

桌面端的「设置 → 模型 → 自定义模型」最终落盘到 `~/.workbuddy/models.json`，
所以可以一键生成整份配置：

```bash
node tools/gen_client_models.js http://<你的服务器>:8790/v1 SK-xxxxxxxx
```

它会：
1. 备份现有 `~/.workbuddy/models.json`
2. 写入 43 个可用模型（过滤掉纯补全/图像/视频模型），全部指向你的网关
3. 带上 `supportsToolCall` / `supportsImages` / `supportsReasoning` 等能力标记

写完后 **完全退出 WorkBuddy 再重新打开**，
在对话框模型选择器的「自定义模型」分组里就能看到「Deepseek-V4-Pro（工作台）」这类条目。

模型列表（`/v1/models`）会随上游产品配置同步，58 个 id 全在里面。

### 命令行客户端

Claude Code / opencode / Cline / Continue 等任何 OpenAI 兼容客户端：

```bash
export OPENAI_BASE_URL="http://<你的服务器>:8790/v1"
export OPENAI_API_KEY="SK-xxxxxxxx"
```

> 注意上游只认真实模型 id（如 `deepseek-v4-pro`、`glm-5.3`），传 `gpt-4o` 会 400。
> 网关侧做了兜底映射：未知模型名会落到 `default`，
> 也可以在 `settings.proxy.modelMap` 里配 `{ "客户端模型名": "上游模型ID" }`。

---

## 五、接口契约（已实测确认）

跟官方一致，全部走 `https://www.workbuddy.cn`：

| 用途 | 方法与路径 | 说明 |
|---|---|---|
| 签到状态 | `POST /v2/billing/meter/checkin-activity-status` | body `{}`，返回连续天数、今日是否已签、积分总额 |
| 执行签到 | `POST /v2/billing/meter/daily-checkin` | body `{}` |
| 额度汇总 | `POST /v2/billing/meter/get-user-resource-summary` | |
| 免费资源包 | `POST /v2/billing/meter/get-user-resource-free-packages` | |
| 付费资源包 | `POST /v2/billing/meter/get-user-resource-paid-packages` | |
| 对话 | `POST /v2/chat/completions` | 反代据此透传 |

请求头：

```
Authorization: Bearer <accessToken>
X-User-Id: <uid>
X-Source: workbuddy
X-Enterprise-Id / X-Tenant-Id   （企业账号）
```

响应统一是 `{ code, msg, data }`，`code === 0` 为成功；401/403 视为凭证失效。

> 这几个路径是从客户端自身的请求构造代码里读出来的，并用无效令牌打过一次：
> 返回 **401** 而不是 404，说明域名、路径、鉴权头格式都对得上。

---

## 六、安全设计

| 项 | 实现 |
|---|---|
| 管理员口令 | scrypt（N=16384, r=8, p=1）加盐哈希，不存明文 |
| 会话 | HMAC-SHA256 签名票据，HttpOnly + SameSite=Lax，默认 72 小时 |
| CSRF | 所有写操作要求 `x-wb-csrf` 头与会话内令牌一致 |
| 登录限流 | 默认 10 分钟内 8 次失败即锁定 |
| 数据落盘 | 整库 AES-256-GCM，`data/db.enc` 单文件 |
| 主密钥 | 环境变量或 `data/master.key`（600），不进代码库 |
| 响应头 | CSP、X-Frame-Options、nosniff、Referrer-Policy、Permissions-Policy |
| 静态服务 | 路径规范化 + 目录越界拒绝 |
| 代理密钥 | `SK-` 前缀随机串，可一键重置 |
| 配对码 | 6 位数字、10 分钟、一次性、错 8 次作废 |

**部署到公网时请务必：** 用 HTTPS（Nginx 反代 + 证书）、`HOST=127.0.0.1` 只让反代访问、
在「设置」里关掉「信任反向代理头」以外不要开匿名调用。

---

## 七、目录结构

```
jwd-server/
├── server.js               HTTP 服务、路由、鉴权中间件、静态资源
├── lib/
│   ├── crypto.js           AES-256-GCM 整库加密、scrypt 口令、会话签名
│   ├── store.js            加密 JSON 数据层（临时文件 + rename 原子落盘）
│   ├── auth.js             登录、会话、CSRF、限流
│   ├── accounts.js         账号 CRUD、额度刷新、签到执行
│   ├── wb.js               WorkBuddy 官方接口客户端
│   ├── proxy.js            OpenAI 兼容反代 + 调度 + 故障转移
│   ├── meow.js             小喵旅行业务层（状态机 / 选地点 / 领取 / 熔断）
│   ├── qrlogin.js          扫码登录：服务端跑登录页、抓二维码、收会话 Cookie
│   └── sched.js            定时任务（自动签到 / 额度刷新 / 小喵巡检）
├── public/index.html       单页控制台（零外链、零构建）
├── extension/              浏览器扩展（MV3）
├── deploy/
│   ├── nginx.conf
│   └── jwd.service
├── data/                  运行时生成：db.enc、master.key、models.json
├── Dockerfile
├── docker-compose.yml
└── .env.example
```

### 控制台界面（v2 科技风）

单页控制台整体重做过视觉层，风格是深空蓝 + 青/靛渐变的 HUD 仪表盘：

- **背景层**：径向网格 + 三团光晕 + 缓慢下扫的扫描线，纯 CSS，零请求。
- **左侧导航分组**：监控（概览 / 运行日志）、资源（账号 / 签到 / 小喵）、网关（代理）、系统（设置）；
  当前项有左侧发光竖条 + 渐变底色，徽标显示实时计数。
- **运行日志独立成页**（左侧导航第二项），原先堆在概览底部的那一大块已经移除，
  概览只保留 6 条「最近动态」摘要并给出跳转按钮。
- **日志控制台**：`TIME / LEVEL / MESSAGE` 三列，左侧色条按级别区分；
  支持级别过滤（全部 / 信息 / 警告 / 错误）、关键词搜索、5 秒自动刷新、清空；
  四个角有 HUD 装饰角标。数据来自 `GET /api/logs?limit=200`（服务端保留 400 条）。
- **系统状态条**：概览页顶部一行四格，实时显示网关开关、自动签到、小喵巡检、模型池数量。
- **卡片**：渐变边框 + 四角 HUD 角标 + 悬停上浮发光；统计磁贴用发光数字。
- **移动端**：单列布局，日志行改为时间 / 级别 / 内容三行堆叠，底部标签栏 7 项。

配套后端接口：

| 接口 | 说明 |
| --- | --- |
| `GET /api/logs?limit=200` | 返回日志数组 + 各级别计数 + 库内总数（需登录） |
| `GET /api/state` | 新增 `logsTotal` 字段，供导航徽标显示真实总数 |

---

## 八、运维

**备份**：`data/db.enc` + `data/master.key`（或 `WB_MASTER_KEY` 环境变量）两个一起才算完整备份。
「设置 → 数据 → 下载加密数据」可以直接导出 db.enc。

**换机迁移**：把这两个文件放到新机器同名目录，同一份主密钥，启动即恢复。

**升级**：`docker compose up -d --build` 或 `systemctl restart jwd`。数据文件向前兼容。

**日志**：页面「概览」有最近 400 条；容器日志 `docker compose logs -f`。

**打包发布**：`bash tools/build_release.sh` 会在 `dist/` 下产出

| 产物 | 用途 |
|---|---|
| `jwd-server-<时间戳>.tar.gz` / `.zip` | 源码包（不含 `data/`），直接上传服务器 |
| `jwd-data-<时间戳>.tar.gz` | 数据迁移包（`db.enc` + `master.key`），把本机账号搬过去时用 |
| `jwd-server-<时间戳>.sha256` | 校验和 |

服务器端的完整步骤见 `deploy/DEPLOY.md`（Docker / systemd 两套方案 + 上线自检清单）。

---

## 八·五、小喵自动领取

猫出门后到点会自动把积分领回来，**不用再手动点「领取奖励」**。

- 「回来自动领积分」开关**默认开启**，巡检每 5 分钟查一次（间隔可调）。
- 它和「自动巡检」是**两个独立开关**：
  - 只开「回来自动领积分」→ 到点自动领，空闲时**不会**自动派出（派出要消耗每天一次的额度）；
  - 再打开「自动巡检」→ 空闲时也会自动派出。
- 领取不受「一天只能派一次」限制：当天派出过、额度已用完，猫回来了照样能领。
- 领取成功后自动刷新额度，页面积分数字不会滞后。

> 上一版有个坑：每日上限检查写在流程最前面，导致猫回来了也永远走不到领取分支。
> 现在顺序改成「先查状态 → 到点先领 → 在路上等 → 空闲才谈派出」。

---

## 九、已知边界（不糊弄）

1. **桌面客户端的加密凭证无法离线解密。** 客户端 5.6.2 起把凭据用 AES-GCM 加密，
   保护密钥由 Electron 原生绑定在运行时提供（`keyblob` 里只有被包裹的用户密钥，
   而解开它的 protector key 不落盘）。这条路走不通，也不该走 ——
   服务器本来就读不到用户本机的加密文件，所以本项目改用浏览器扩展在同一登录态下取凭证，
   这既符合原文章「网页授权后自动入库」的实际行为，也能跨机器、跨账号复用。
2. **小喵接口是真实的，不需要你填路径。** 网页版成长中心
   （`https://www.workbuddy.cn/profile/growth-center`）的前端 bundle
   `growthSpace-BR3JGo_d.js` 里就写着全部接口，本项目和它完全一致：

   | 用途 | 方法与路径 | 参数 |
   |---|---|---|
   | 地点配置 | `GET /activity/growth/buddy/travel/config` | — |
   | 当前状态 | `GET /activity/growth/buddy/travel/status` | — |
   | 派出旅行 | `POST /activity/growth/buddy/travel/depart` | `{ "location_id": 1 }` |
   | 领取奖励 | `POST /activity/growth/buddy/travel/claim` | `{}` |
   | 旅行记录 | `GET /activity/growth/buddy/travel/records?page=1&page_size=20` | — |
   | 旅行 Buddy | `GET /activity/growth/buddy/info` | — |

   **`location_id` 必须是数字。** 上游 config 返回的地点 id 是整数（1/2/3/4），
   另有一个字符串 `code`（`coffee`/`mall`/`gym`/`ancient_town`）。
   depart 只认整数：传 `"1"` 或 `"coffee"` 都会被判成 `HTTP 400 {"code":400,"msg":"invalid request"}`。
   所以 `lib/wb.js` 的 `normLocation()` 用 `pickId()` 保留数字类型，
   `pickStr()` 那种「只取字符串」的写法会悄悄退到 `code` 上，直接把请求打废。

   状态机只有三个值：`idle`（可派出）、`traveling`（旅途中）、`arrived`（可领取）。
   响应体是 `{ code, msg, data }`，`data` 里带 `state / location / depart_at / arrive_at /
   server_now / letter / daily_limit_reached / reward_credit`。
   一天只能派一次，上游会用 `HTTP 429` 或 `msg` 含 `daily limit` 拒绝，
   这正是网页上「猫猫今天累啦，明天再来吧」的来源。本项目收到就直接按当日熔断处理。

   **上游用 `HTTP 403` 同时表达「凭证失效」和业务拒绝**，所以必须先按 `msg` 判语义：
   `already traveling` → 已在旅行中，`not arrived yet` → 还没到点，
   两者都不是凭证问题，不能把账号误标成凭证失效。

   注意：`/activity/growth/*` 这一整段路径被网关统一拦鉴权，
   **无效令牌和有效令牌打不存在的子路径都会返回 401**，所以不能拿 401 当路径验证手段。
   接口契约以上述官方前端源码为准。

3. **鉴权支持两条路，扩展会同时取。** 网页版用 Cookie（`withCredentials`），
   客户端用 `Authorization: Bearer`。所以账号里保存 `token` 或 `cookie` 任一即可：
   扩展用 `chrome.cookies` 取回完整 Cookie（含 HttpOnly），也会顺手扫 `accessToken`。
   只有 Cookie 时，签到走计费接口可能不通，但成长中心和小喵完全可用。
4. **跨账号数据迁移（会话 / 记忆 / Agent / 技能 / 产出文件）未实现。**
   这部分操作的是 WorkBuddy 本机数据目录，属于桌面端能力；服务器版做的是账号与额度治理。
   如果你的实际场景需要它，告我一声，可以按「服务器侧只做备份/导出、迁移仍在本机工具里做」来补。

---

## 十、命令速查

```bash
node server.js                     # 启动
PORT=9000 node server.js           # 换端口
WB_DATA_DIR=/data node server.js   # 换数据目录
node --check server.js             # 语法检查
bash tools/build_release.sh        # 打包发布（源码包 + 数据迁移包 → dist/）
node tools/selftest_meow.js        # 小喵派出发送/自动领取自检（假上游，不碰真实接口）
node tools/verify_meow_live.js     # 小喵真实上游复验（只读 + 会真发 depart）
node tools/selftest_proxy.js       # OpenAI 兼容反代自检（SSE / 模型映射 / usage / 缓存友好化）
node tools/selftest_http_security.js  # HTTP 安全自检（静态目录越权 / 伪造头 / 头超时）
node tools/selftest_browser_idle.js    # 浏览器空闲自动关闭自检
node tools/selftest_ui.js          # 控制台 UI 自检（Playwright，需本地已起服务）
```

健康检查：`GET /api/session` 返回 200 即存活（Dockerfile 里的 HEALTHCHECK 用的就是它）。
