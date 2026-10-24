# syntax=docker/dockerfile:1.7
# Real-time collaboration service (Hocuspocus/Yjs). Internal network only; the app tunnels authenticated sockets to it.
ARG NODE_VERSION=22.23.4-alpine

FROM node:${NODE_VERSION} AS build
WORKDIR /collab
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:${NODE_VERSION} AS runtime
ENV NODE_ENV=production PORT=1234
WORKDIR /collab
COPY --from=build /collab/node_modules ./node_modules
COPY --from=build /collab/dist ./dist
COPY package.json ./
USER node
EXPOSE 1234
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||1234)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server.js"]
