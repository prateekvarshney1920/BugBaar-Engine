# syntax=docker/dockerfile:1

# ---- Build stage: install every dependency and compile TypeScript ----
FROM node:22-alpine AS build
WORKDIR /app

# mongodb-memory-server is a test-only dependency; stop it fetching a mongod
# binary during the image build.
ENV MONGOMS_DISABLE_POSTINSTALL=1

COPY package.json package-lock.json* tsconfig.base.json tsconfig.json ./
COPY tools/package.json ./tools/
COPY agents/package.json ./agents/
COPY rag/package.json ./rag/
COPY workflows/package.json ./workflows/
COPY persistence/package.json ./persistence/
COPY queue/package.json ./queue/
COPY api/package.json ./api/
COPY backend/package.json ./backend/
# The dashboard is a workspace in the lockfile, so its manifest must exist for
# `npm ci` even though the image serves only the API.
COPY frontend/package.json ./frontend/
RUN npm ci

COPY . .
RUN npm run build

# ---- Runtime stage: production dependencies plus compiled output ----
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/package.json /app/package-lock.json* ./
COPY --from=build /app/tools/package.json ./tools/
COPY --from=build /app/agents/package.json ./agents/
COPY --from=build /app/rag/package.json ./rag/
COPY --from=build /app/workflows/package.json ./workflows/
COPY --from=build /app/persistence/package.json ./persistence/
COPY --from=build /app/queue/package.json ./queue/
COPY --from=build /app/api/package.json ./api/
COPY --from=build /app/backend/package.json ./backend/
COPY --from=build /app/frontend/package.json ./frontend/
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/tools/dist ./tools/dist
COPY --from=build /app/agents/dist ./agents/dist
COPY --from=build /app/rag/dist ./rag/dist
COPY --from=build /app/workflows/dist ./workflows/dist
COPY --from=build /app/persistence/dist ./persistence/dist
COPY --from=build /app/queue/dist ./queue/dist
COPY --from=build /app/api/dist ./api/dist
COPY --from=build /app/backend/dist ./backend/dist

# Run unprivileged; the node image ships a `node` user for exactly this.
USER node
EXPOSE 4000
CMD ["node", "backend/dist/server.js"]
