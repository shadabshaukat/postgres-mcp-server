FROM node:22-alpine AS builder
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/build ./build

ENV MCP_TRANSPORT=sse
ENV MCP_HTTP_HOST=0.0.0.0
ENV MCP_HTTP_PORT=8899
ENV MCP_HTTP_PATH=/mcp
ENV MCP_DB_MODE=restricted

EXPOSE 8899

ENTRYPOINT ["node", "build/index.js"]