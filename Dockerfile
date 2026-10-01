# syntax=docker/dockerfile:1

# ---------- 依赖层（利用缓存） ----------
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ---------- verify / 构建层 ----------
FROM node:20-alpine AS verify-base
WORKDIR /app
ENV CI=true
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# 构建期即完成类型检查（vue-tsc）与产物构建，保证镜像内代码可编译。
RUN npm run build
# verify 服务在该镜像上由 docker-compose 覆盖 command 执行测试。

# ---------- 静态 Web 服务 ----------
FROM nginx:1.27-alpine AS web
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=verify-base /app/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=10s --timeout=3s --retries=5 \
  CMD wget -qO- http://127.0.0.1/ >/dev/null 2>&1 || exit 1
CMD ["nginx", "-g", "daemon off;"]
