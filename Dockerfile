FROM node:22-bookworm-slim

# 扫码登录需要真实的浏览器内核：服务端要自己把 workbuddy.cn 登录页跑起来抓二维码。
# 用发行版自带的 chromium，比 playwright 自带下载的版本更省事，也不用联网装浏览器。
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      chromium \
      fonts-noto-cjk \
      fontconfig \
      ca-certificates \
      tini \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY server.js ./
COPY lib ./lib
COPY public ./public
COPY README.md DEPLOY.md ./

# 自检脚本（上线后可在容器里跑 node tools/selftest_meow.js 验证核心链路）
COPY tools ./tools

RUN mkdir -p /app/data && chown -R node:node /app
USER node

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8790 \
    WB_CHROMIUM_PATH=/usr/bin/chromium

EXPOSE 8790
VOLUME ["/app/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8790/api/session').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server.js"]
