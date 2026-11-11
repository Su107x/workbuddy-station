'use strict';
/**
 * 加密 JSON 数据层：整个库一个密文文件，写入用「临时文件 + rename」保证原子性。
 */
const fs = require('fs');
const path = require('path');
const { Cipher } = require('./crypto');

function nowIso() {
  return new Date().toISOString();
}

function defaultData() {
  return {
    version: 1,
    createdAt: nowIso(),
    admin: { passwordHash: '', initializedAt: '' },
    settings: {
      siteTitle: 'WorkBuddy 账号工作台',
      publicBaseUrl: '',
      checkin: {
        autoEnabled: false,
        time: '08:30',
        retry: 2,
        refreshQuotaAfter: true,
      },
      quota: {
        autoRefreshMinutes: 30,
      },
      proxy: {
        enabled: false,
        accessKey: '',
        strategy: 'balance', // balance | expiry | roundrobin | drain
        stickyTtlMin: 30,
        maxFailover: 2,
        modelAlias: 'default',
        // 客户端自定义模型名 → 上游真实模型 ID 的映射
        modelMap: {},
        // 模型白名单：只保留这些模型（空数组 = 全部保留，不做过滤）。
        // /v1/models 只暴露白名单内的模型；客户端请求不在名单里的模型会落到自动选型。
        modelWhitelist: [],
        // 自动选型开关（依赖上游 /v3/config 的时段促销）：
        //   开启后，客户端没指定白名单内模型时自动挑 ——
        //   ① 当前有 0 倍率（真免费）的模型 → 用它
        //   ② 否则在白名单内挑倍率最低的
        autoSelectModel: false,
        allowAnonymous: false,
        // 缓存友好化：稳定 tools 顺序 + 归一化 system prompt 时间戳，
        // 让上游提示词缓存能命中，输入侧积分可降到 1/20
        cacheFriendly: true,
        // ---- 远端核心决策服务（core-server）----
        // 留空 = 不启用，所有决策走本地实现（自用行为完全不变）。
        // 填写形如 http://127.0.0.1:8791 或 http://1.2.3.4:8791 即启用。
        coreUrl: '',
        // licence token（向服务方申请，绑定本机设备指纹）
        coreLicence: '',
        // 平台密钥：配置后可对请求/响应做 HMAC 签名。**交付版不要带**。
        coreSecret: '',
        // core 不可用时是否回落本地实现。
        //   true  = 自用（本地有完整实现，回落不会缺功能）
        //   false = 交付版（本地没有决策代码，宁可报错也不静默降级）
        coreFallback: true,
        // core 请求超时
        coreTimeoutMs: 8000,
      },
      // 模型目录自动同步：每天拉一次官方目录，
      // 新增的免费模型自动入白名单、下架的自动剔除、倍率变动记日志
      modelSync: {
        enabled: true,
        intervalHours: 24,
      },
      meow: {
        enabled: false,
        intervalMinutes: 60,
        // longest 时长最长 | shortest 时长最短 | rotate 轮换 | fixed 固定地点
        strategy: 'shortest',
        fixedLocationId: '',
        rotateIndex: 0,
        autoCollect: true,
        // 回来自动领积分：与「自动派出」解耦，只领不派
        autoClaim: true,
        claimIntervalMinutes: 5,
        stopOnLimit: true,
      },
      security: {
        sessionHours: 72,
        loginMaxAttempts: 8,
        loginWindowMinutes: 10,
        trustProxy: false,
      },
      // 成长任务（Growth Program）
      growth: {
        autoEnabled: false,
        intervalMinutes: 30,
        // 只领取「已完成未领取」的任务，已领取的会被上游幂等拒绝
        autoAccept: false,
        /* 点亮开关（模拟行为事件把任务打到 completed）。
         * 必须显式为 true 才真正发上报，默认关闭：
         * 上游把 full 模式定性为「风控最容易识别」并排除在定时之外，
         * 因此点亮只能由手动接口触发，禁止接进定时巡检（sched.js 里不得调用 completeAll）。
         */
        allowLightUp: false,
      },
      // 邀请活动
      invite: {
        // 绑定的邀请码（被邀请方视角）
        inviteCode: '',
        // 注册完成后自动完成一次对话以激活奖励
        autoActivate: true,
        model: '',
      },
      /* 积分体系：实时余额 + 到期监控
       * 上游 /status 的积分滞后可达数小时，因此单独查计费接口拿实时值。
       * 积分按套餐分批过期、过期即作废，所以每笔单独算到期时间。
       */
      credits: {
        enabled: true,
        refreshMinutes: 30,
      },
      /* 保活：令牌自动续期 + 活跃上报
       * 闲置账号如果长期不被调用，上游不会刷新令牌，会一路走到过期。
       * 因此主动检查有效期，剩余不足 renewDaysThreshold 天就换新。
       */
      keepalive: {
        enabled: false,
        renewDaysThreshold: 3,
        activeReport: false,
        // 每日轻量对话：让账号保有真实调用记录（不能点亮成长热力图，见 keepalive.reportActive 注释）
        dailyChat: true,
        dailyChatPrompt: '你好，请回复一个字：好',
        intervalMinutes: 720,
      },
      /* 签到里程碑兑换（7/14/28 天档位）
       * ★ 默认「每周」巡检一次，不是每天 —— 档位 7/14/28 天才会到，每天扫是浪费请求。
       *   另外会记住每个号的 nextEligibleAt（按当前连续天数推算还差几天到下一档），
       *   到点的那一轮会提前触发，不必干等满 7 天。
       */
      streakRedeem: {
        enabled: true,
        intervalMinutes: 7 * 24 * 60, // 每周一次
        autoLottery: true,            // 兑换到的抽奖机会立刻抽掉
        autoMakeup: true,             // 有补登卡 + 本月有漏签 → 自动补最近一次
      },
      /* 账号错峰：多账号同时打腾讯会形成明显的批量特征
       * randomDelayMinutes   同类任务每天整体随机延后 0~60 分钟
       * accountDelayMin/Max  同一批里账号之间随机间隔（秒）
       * 两项都为 0 时保持原有"到点即跑"的行为。
       */
      schedule: {
        randomDelayMinutes: 0,
        accountDelayMinSeconds: 0,
        accountDelayMaxSeconds: 0,
      },
    },
    accounts: [],
    logs: [],
    stats: {
      since: nowIso(),
      byDay: {},
      proxyTotal: 0,
      proxyFail: 0,
    },
    // 逐请求用量明细（最近 200 条），用于定位积分消耗构成
    usageLog: [],
  };
}

function deepMerge(base, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return base;
  for (const k of Object.keys(patch)) {
    const v = patch[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      deepMerge(base[k], v);
    } else if (v !== undefined) {
      base[k] = v;
    }
  }
  return base;
}

class Store {
  constructor(dataDir, key) {
    this.dataDir = dataDir;
    this.file = path.join(dataDir, 'db.enc');
    this.cipher = new Cipher(key);
    this.data = defaultData();
    this._saveTimer = null;
    this._saving = false;
    this._dirty = false;
  }

  load() {
    fs.mkdirSync(this.dataDir, { recursive: true });
    if (fs.existsSync(this.file)) {
      const raw = fs.readFileSync(this.file, 'utf8');
      const loaded = this.cipher.open(raw);
      this.data = deepMerge(defaultData(), loaded);
    } else {
      this.data = defaultData();
      this.saveNow();
    }
    return this.data;
  }

  /** 合并补丁并延迟落盘 */
  patch(section, value) {
    if (value === undefined) {
      this.data[section] = value;
    } else if (value && typeof value === 'object' && !Array.isArray(value) && this.data[section] && typeof this.data[section] === 'object') {
      deepMerge(this.data[section], value);
    } else {
      this.data[section] = value;
    }
    this.touch();
  }

  touch() {
    this._dirty = true;
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this.saveNow();
    }, 400);
  }

  saveNow() {
    if (this._saving) return;
    this._saving = true;
    try {
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, this.cipher.seal(this.data), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
      this._dirty = false;
    } finally {
      this._saving = false;
    }
  }

  /** 进程退出前强制落盘 */
  flush() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    this.saveNow();
  }

  log(level, message, extra) {
    const entry = {
      at: nowIso(),
      level,
      message: String(message || '').slice(0, 500),
      extra: extra || undefined,
    };
    const logs = this.data.logs;
    logs.unshift(entry);
    if (logs.length > 400) logs.length = 400;
    this.touch();
    return entry;
  }

  bumpStat(day, field, delta) {
    const s = this.data.stats;
    if (!s.byDay[day]) s.byDay[day] = { checkin: 0, proxy: 0, fail: 0, credits: 0 };
    s.byDay[day][field] = (s.byDay[day][field] || 0) + delta;
    const days = Object.keys(s.byDay).sort();
    while (days.length > 90) delete s.byDay[days.shift()];
    this.touch();
  }
}

module.exports = { Store, defaultData, nowIso, deepMerge };
