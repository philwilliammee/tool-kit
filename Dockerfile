# ── Stage 1: Builder ──────────────────────────────────────────────────────────
FROM node:22-alpine AS builder
WORKDIR /app

# Install main project deps (includes devDeps for TypeScript)
COPY package*.json ./
RUN npm install

# Install MCP server deps
COPY mcp/bash-server/package*.json ./mcp/bash-server/
RUN cd mcp/bash-server && npm install

COPY mcp/octokit-mcp-server/package*.json ./mcp/octokit-mcp-server/
RUN cd mcp/octokit-mcp-server && npm install

COPY mcp/file-editor-mcp-server/package*.json ./mcp/file-editor-mcp-server/
RUN cd mcp/file-editor-mcp-server && npm install

# Copy source and compile main project
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# Copy and compile MCP server sources
COPY mcp/bash-server/ ./mcp/bash-server/
RUN cd mcp/bash-server && npm run build

COPY mcp/octokit-mcp-server/ ./mcp/octokit-mcp-server/
RUN cd mcp/octokit-mcp-server && npm run build

COPY mcp/file-editor-mcp-server/ ./mcp/file-editor-mcp-server/
RUN cd mcp/file-editor-mcp-server && npm run build

# Prune main project to production deps only
RUN npm prune --omit=dev


# ── Stage 2: Final image ──────────────────────────────────────────────────────
FROM node:22-alpine
WORKDIR /app

# bash is required by the bash MCP server at runtime
RUN apk add --no-cache bash

# Main server — compiled output and production deps
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json

# Runtime config
COPY config/ ./config/

# MCP servers — build output + production deps + package.json (ESM type field)
COPY --from=builder /app/mcp/bash-server/build ./mcp/bash-server/build
COPY --from=builder /app/mcp/bash-server/node_modules ./mcp/bash-server/node_modules
COPY --from=builder /app/mcp/bash-server/package.json ./mcp/bash-server/package.json

COPY --from=builder /app/mcp/octokit-mcp-server/build ./mcp/octokit-mcp-server/build
COPY --from=builder /app/mcp/octokit-mcp-server/node_modules ./mcp/octokit-mcp-server/node_modules
COPY --from=builder /app/mcp/octokit-mcp-server/package.json ./mcp/octokit-mcp-server/package.json

COPY --from=builder /app/mcp/file-editor-mcp-server/build ./mcp/file-editor-mcp-server/build
COPY --from=builder /app/mcp/file-editor-mcp-server/node_modules ./mcp/file-editor-mcp-server/node_modules
COPY --from=builder /app/mcp/file-editor-mcp-server/package.json ./mcp/file-editor-mcp-server/package.json

EXPOSE 3333

# Env vars are injected at runtime — no --env-file flag here
CMD ["node", "dist/server/server.js"]
