# Resale Ops — single container: API, background worker and dashboard.
# NOTE: this image definition has not been built or run by the author of this
# repository (Docker was not available on the development machine). Build it
# and run the test suite inside it before relying on it.
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run web:build && npm run typecheck

FROM node:24-bookworm-slim
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4000 DATA_DIR=/data
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/src ./src
COPY --from=build /app/migrations ./migrations
COPY --from=build /app/web/dist ./web/dist
COPY tsconfig.json ./
RUN useradd --system --uid 10001 resale && mkdir -p /data && chown resale /data
USER resale
VOLUME /data
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD node -e "fetch('http://127.0.0.1:4000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "node_modules/tsx/dist/cli.mjs", "src/main.ts"]
