FROM node:24-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/viewer/package.json apps/viewer/package.json
COPY packages/fig-engine/package.json packages/fig-engine/package.json
RUN npm ci --no-audit --no-fund

FROM dependencies AS build
COPY . .
RUN npm run build

FROM node:24-bookworm-slim AS production-dependencies
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/viewer/package.json apps/viewer/package.json
COPY packages/fig-engine/package.json packages/fig-engine/package.json
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:24-bookworm-slim AS server
WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3210 \
    FIGMA_LIBRARY_DIR=/app/apps/server/data/projects
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=production-dependencies /app/package.json ./package.json
COPY --from=production-dependencies /app/apps/server/package.json ./apps/server/package.json
COPY --from=production-dependencies /app/packages/fig-engine/package.json ./packages/fig-engine/package.json
COPY --from=build /app/apps/server/dist ./apps/server/dist
COPY --from=build /app/packages/fig-engine/dist ./packages/fig-engine/dist
COPY --from=build /app/packages/fig-engine/assets/fonts ./packages/fig-engine/assets/fonts
EXPOSE 3210
CMD ["node", "apps/server/dist/main.js"]

FROM nginx:stable-alpine AS viewer
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/viewer/dist/figma-reader/browser /usr/share/nginx/html
EXPOSE 80
