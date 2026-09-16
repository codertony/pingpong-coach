# syntax=docker/dockerfile:1
#
# pingpong-coach 生产镜像。
#
# 单容器同时提供 **API 与前端静态产物** —— `apps/api` 本身就托管
# `apps/web/dist`（见 apps/api/src/server.ts 的 fastifyStatic 注册 + SPA 回退），
# 所以不需要额外的 nginx 或第二个容器。
#
# ⚠️ 无法在本机验证：开发环境没有 docker（见 docs/roadmap.md A7）。
# 本文件按"能在本机执行的等价命令"逐条对齐（见文末注释），
# 但**没有跑过一次真实的 docker build** —— 不要把它当成已验证。
#
# 构建：
#   docker build -t pingpong-coach .
# 运行：
#   docker run --rm -p 8787:8787 pingpong-coach
#   然后打开 http://127.0.0.1:8787
#
# 接入真实模型（默认 mock，不配也能跑通全链路）：
#   docker run --rm -p 8787:8787 \
#     -e PPC_MODEL_API_KEY=sk-xxx \
#     -e PPC_MODEL_BASE_URL=https://your-endpoint/v1 \
#     -e PPC_MODEL_ID=your-model-id \
#     pingpong-coach

# ── 构建阶段：装依赖 → 全量构建 → 拉模型资产 ──────────────────────
FROM node:22-bookworm-slim AS builder

# corepack 按 packageManager 字段启用正确的 pnpm 版本，不靠手工 pin
RUN corepack enable

WORKDIR /app

# 先只复制清单文件：依赖没变时这一层能命中缓存，改代码不会重装依赖
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/api/package.json      apps/api/
COPY apps/web/package.json      apps/web/
COPY packages/contracts/package.json  packages/contracts/
COPY packages/motion-core/package.json packages/motion-core/

RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

# 再复制源码并构建。
# `pnpm build` = 各包 tsc --noEmit + vite build；
# vite 会把 apps/web/public/ 下的 models 与 wasm 一并复制进 dist。
COPY . .

# 模型权重（约 22 MB）不在 Git 里，构建时按 manifest 下载并校验 sha256。
# 校验失败会明确报错，不会静默换版本。
# 网络受限时可加 --build-arg SKIP_MODELS=1 跳过，并在运行时挂载 /app/web/dist/models。
ARG SKIP_MODELS=0
RUN if [ "$SKIP_MODELS" != "1" ]; then pnpm models:fetch; fi

RUN pnpm build

# ── 生产依赖阶段：只装运行时需要的包 ────────────────────────────
FROM node:22-bookworm-slim AS prod-deps
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/api/package.json      apps/api/
COPY apps/web/package.json      apps/web/
COPY packages/contracts/package.json  packages/contracts/
COPY packages/motion-core/package.json packages/motion-core/
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --prod

# ── 运行阶段 ────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS runner

RUN corepack enable
WORKDIR /app
ENV NODE_ENV=production

# 生产依赖（含 workspace 软链，所以三个包的 package.json 都在）
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/packages/contracts/node_modules  ./packages/contracts/node_modules
COPY --from=prod-deps /app/packages/motion-core/node_modules ./packages/motion-core/node_modules
COPY --from=prod-deps /app/apps/api/node_modules            ./apps/api/node_modules
COPY --from=prod-deps /app/apps/web/node_modules            ./apps/web/node_modules

# 源码与配置。API 用 tsx 直接跑 TypeScript —— 与 package.json 的 `start` 脚本一致，
# 所以不需要额外做一次 tsc 产出 JS。
COPY --from=builder /app/package.json /app/pnpm-workspace.yaml /app/.npmrc ./
COPY --from=builder /app/packages/contracts  ./packages/contracts
COPY --from=builder /app/packages/motion-core ./packages/motion-core
COPY --from=builder /app/apps/api            ./apps/api
COPY --from=builder /app/apps/web/dist       ./apps/web/dist
# 知识条目：后端启动时读取，缺失会让 /api/coach/analyze 直接失败
COPY --from=builder /app/knowledge           ./knowledge
COPY --from=builder /app/apps/web/package.json ./apps/web/package.json

# 知识目录与前端产物都用**绝对路径**固定。
# 两者在源码里都是相对 process.cwd() 解析的（../../knowledge、../web/dist），
# 而容器里从哪个目录起进程并不确定 —— 显式给绝对路径才不会踩到。
ENV KNOWLEDGE_DIR=/app/knowledge \
    WEB_DIST=/app/apps/web/dist \
    PORT=8787 \
    HOST=0.0.0.0

EXPOSE 8787

# 非 root 运行。node 官方镜像自带 uid 1000 的 node 用户。
RUN chown -R node:node /app
USER node

# 探活：容器编排可以直接用这个判断是否就绪
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# 与 package.json 的 `start` 等价，只是不经 pnpm 转发（少一层进程）
CMD ["node", "node_modules/.bin/tsx", "apps/api/src/server.ts"]
