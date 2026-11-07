# 主 WorkBuddy 挂工作台积分 —— 接入说明

## 一句话

主 WorkBuddy 桌面端不动、不切账号，把闲置账号的积分当自己的额度用。
所有模型对话经你服务器上的工作台网关转发，账号池怎么调度你说了算。

---

## 一、当前状态（已实测跑通）

| 项 | 值 |
|---|---|
| 网关地址 | `http://<YOUR_SERVER_IP>:8790/v1` |
| 接口地址（填客户端用） | `http://<YOUR_SERVER_IP>:8790/v1/chat/completions` |
| API Key | `<YOUR_GATEWAY_API_KEY>` |
| 模型数 | 58（`/v1/models` 可查） |
| 账号池 | 1 个真实账号（夫君，200 积分），可继续扫码加号 |
| 调度策略 | 余额优先 + 60 分钟粘性会话 + 失败换号 2 次 |

---

## 二、客户端配置（已自动写入）

`C:\Users\XZ\.workbuddy\models.json` 已写好 **43 个模型**（排除了纯补全/图像/视频模型），
备份在同目录 `models.json.bak-*`。

**下一步（你要做的）**：

1. **完全退出 WorkBuddy**（托盘图标也退出，不是关窗口）
2. 重新打开
3. 对话框底部的模型选择器 → 拉到最下方 **「自定义模型」** 分组
4. 选 `Deepseek-V4-Pro（工作台）` 之类的条目
5. 正常对话 —— 走的已经不是你主账号的额度，而是池子里账号的积分

> 换模型/改配置重新生成：
> ```bash
> cd jwd-server
> node tools/gen_client_models.js http://<YOUR_SERVER_IP>:8790/v1 <YOUR_GATEWAY_API_KEY>
> ```

### 手动配置（等价路径）

设置 → 模型 → 自定义模型 → 添加模型：

| 字段 | 填写内容 |
|---|---|
| 提供商 | 自定义 / Custom |
| 接口地址 | `http://<YOUR_SERVER_IP>:8790/v1/chat/completions` |
| API Key | `<YOUR_GATEWAY_API_KEY>` |
| 模型名称 | `deepseek-v4-pro`（或 `glm-5.3` / `kimi-k3-2` 等） |
| 高级工具 | 勾选「工具调用」「图片输入」「推理模式」 |

> ⚠️ 接口地址**必须以 `/chat/completions` 结尾**。填到 `/v1` 会被客户端补成
> `/v1/chat/completions`，效果相同；但填成别的路径会 404。

---

## 三、账号池怎么加号

现在池子里只有 1 个号。要把闲置积分真正池起来：

1. 浏览器打开 `http://<YOUR_SERVER_IP>:8790`
2. 管理员口令登录（你已知）
3. 「账号」页 → **添加账号** → 扫码登录（每台电脑/每个账号各扫一次）
4. 重复直到池里有 N 个号

加完后不用改任何客户端配置 —— 网关会按策略自动在池里挑号。

### 三种调度策略（工作台「代理」页切换）

| 策略 | 行为 | 适合 |
|---|---|---|
| `balance` 余额优先 | 积分多的先用 | 默认，均衡消耗 |
| `roundrobin` 轮询 | 挨个轮 | 想让每个号都动起来 |
| `drain` 集中消耗 | 先榨干积分少的 | 想清空某个小号 |

**粘性会话**（60 分钟）：同一段对话固定用一个号，避免中途换号导致上下文割裂。
**失败换号**（2 次）：某号 401/403/429/5xx 时自动换下一个重试，客户端无感。

---

## 四、关键实现说明（为什么能这么接）

上游 `workbuddy.cn/v2/chat/completions` 的实测行为：

| 特性 | 结论 |
|---|---|
| 非流式请求 | **拒绝**，返回 `400 / code 11101`（"Non-stream chat request is currently not supported"） |
| 流式请求 | 正常，返回标准 OpenAI `chat.completion.chunk` |
| 工具调用 | 支持，`tool_calls` 按 index 分片下发 `arguments` |
| 多轮上下文 | 无状态，客户端带完整 `messages` 即可，记忆正常 |
| 图片输入 | 支持 `image_url`（含 base64 data URL） |
| `reasoning_content` | 支持，末帧 `finish_reason:"stop"` + 完整 `usage`（含 `credit` 积分字段） |
| 模型名 | 只认真实 id，传 `gpt-4o` 会 `400 / code 11102` |

所以网关层做了双向适配（`lib/proxy.js` + `lib/sse.js`）：

- 客户端要**流式** → 逐帧透传上游 SSE，不改一个字节
- 客户端要**非流式** → 网关读干上游 SSE，聚合为标准 `chat.completion`
  （拼 `content` / `reasoning_content`，按 index 合并 `tool_calls.arguments`）

模型名映射（`resolveUpstreamModel`）：
1. 精确命中 `/v1/models` 清单
2. 剥离 `custom:` / `custom-local:` 前缀后再匹配（客户端可能加前缀）
3. 查 `settings.proxy.modelMap` 别名表
4. 兜底到 `modelAlias`（当前 `default`）

---

## 五、其他客户端也能用

```bash
export OPENAI_BASE_URL="http://<YOUR_SERVER_IP>:8790/v1"
export OPENAI_API_KEY="<YOUR_GATEWAY_API_KEY>"
```

Claude Code / opencode / Cline / Continue / 任何 OpenAI SDK 都能直接用。
命令行客户端记得把 `model` 换成 `deepseek-v4-pro` 这类真实 id。

---

## 六、安全提醒

- API Key 现在是明文出现在本机和本文件里的，**公网暴露的 8790 端口靠这个 key 兜底**。
- 泄露后立刻在工作台「代理」页点「重置密钥」，然后重新跑一次 `gen_client_models.js`。
- 想更稳就上域名 + Nginx + certbot 上 HTTPS，然后把 `.env` 里 `WB_TRUST_PROXY=1`。
- 工作台管理口（登录、账号管理）跟 `/v1` 共用一个端口，扫端口的人拿到 key 就能用你的积分。

---

## 七、自测与回归

```bash
cd jwd-server
node tools/selftest_proxy.js       # 代理层 20 项（离线，不触网）
node tools/selftest_meow.js         # 小喵 39 项
node tools/selftest_http_security.js # HTTP 安全 20 项
node tools/selftest_browser_idle.js  # 浏览器空闲 14 项
```

服务器上同样跑过一遍，全绿。

---

## 积分消耗说明（2026-10-29 实测）

### 客户端「共消耗 X」这个数字是什么

来自上游响应里的 `usage.credit`，是**等值标价**，不是账户扣减。
工作台会把它累计到 `stats.byDay.<日期>.credits`，并在「代理 → 积分消耗明细」里
按请求逐条列出（时间 / 模型 / 输入 / 缓存命中 / 输出 / 思考 / 积分）。

> 注：实测当天代理跑了 27 次请求、累计 credit 136.11，
> 而上游签到活动的 `total_credits` 始终是 200（分文未少）。
> 也就是说 credit 是「这次请求折算成多少积分」的计价单位，
> 真正是否扣减要看上游账户账目，不要拿它直接对比余额。

### 积分怎么算出来的

```
credit ≈ 0.00026 × (prompt_tokens - prompt_cache_hit_tokens)   ← 输入未命中缓存
       + 0.0035  × completion_tokens                            ← 输出（含思考 token）
```

**输入未命中缓存的 token 是绝对大头**，输出反而很便宜。

### 为什么一句话要 14 积分

WorkBuddy 桌面端每个请求都会带：

- **system prompt 约 45,000 字符**（客户端日志实测 45183 / 45435 两个值）
- **全部内置工具的 JSON Schema**（本次实测 45 个工具）
- 多轮对话的历史上下文

实测用 45 个工具 + 长 system prompt 模拟客户端单轮请求：

| 场景 | prompt_tokens | 缓存命中 | credit |
|---|---|---|---|
| 冷缓存（首次） | 11,322 | 0 | **2.92** |
| 同样内容再来一次 | 11,322 | 11,264 | **0.14** |
| system prompt 改一个字 | 11,314 | 0 | **2.94** |

客户端那次「询问测试账号与积分」是 23 秒的 agent 多轮循环，
每轮 system prompt 都在 45183/45435 之间跳（工具集按需裁剪），
缓存前缀反复断裂 → 每轮都按全量未命中计费 → 累计 14.19。

## 缓存友好化（已默认开启）

代理层现在会（`settings.proxy.cacheFriendly`，默认 `true`）：

1. **tools 数组按 `function.name` 稳定排序** —— 保证前缀字节完全一致
2. **system prompt 里的时间戳归一化** —— `2026-10-29T17:03:52Z` → `<TIMESTAMP>`，
   `2026-10-29` → `<DATE>`，`17:03:52` → `<TIME>`

只改「发给上游的字节」，不改语义；user / assistant 消息不动。

实测效果（客户端同款负载，system prompt 每轮不同、tools 顺序随机）：

| 轮次 | prompt_tokens | 缓存命中 | credit |
|---|---|---|---|
| 第 1 轮 | 11,322 | 4,992 | 1.76 |
| 第 2 轮 | 11,322 | **11,264** | **0.15**（↓91%）|
| 第 3 轮 | 11,322 | **11,264** | **0.17**（↓90%）|

想还原成原始行为：控制台「代理 → 调度策略 → 缓存友好化」关掉即可。

## models.json 装在哪

**`%USERPROFILE%\.workbuddy\models.json`**，也就是
`C:/Users/XZ/.workbuddy/models.json`（已写好，43 个模型）。

客户端 daemon 的 `CustomModelsProductProvider` 就是读这个路径，
日志里能看到：

```
[CustomModelsProductProvider] productName=WorkBuddy, isWorkBuddy=true,
userConfigPath=C:/Users/XZ/.workbuddy/models.json
```

改完文件客户端会自动热加载（file watcher），不必重启。

### 不要写 availableModels 字段

客户端合并逻辑（`WorkbuddyCustomModelsProductProvider`）有两条分支：

- `availableModels` **是数组** → 拿它覆盖远端内置列表，SmartMerge 后只剩这些 id
- `availableModels` **缺失** → 自动取「远端内置 availableModels ∪ 自定义 id」✅

实测（客户端日志 `snapshot accepted` 的 models 数）：

| 配置 | models 数 |
|---|---|
| 基线（无自定义） | 18 |
| 43 个自定义，**不带** availableModels | **61** ✅ |
| 43 个自定义，**带** availableModels | 55 ❌（反而丢了内置模型）|

所以 `gen_client_models.js` 只写 `models`，不写 `availableModels`。
