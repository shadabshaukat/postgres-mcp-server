FROM node:22-alpine
WORKDIR /app

COPY package.json LICENSE ./
COPY build ./build

ENV NODE_ENV=production
ENV MCP_TRANSPORT=http
ENV MCP_HTTP_HOST=0.0.0.0
ENV MCP_HTTP_PORT=8899
ENV MCP_HTTP_PATH=/mcp
ENV MCP_DB_MODE=restricted

EXPOSE 8899

RUN chown -R node:node /app
USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.MCP_HTTP_PORT || '8899') + '/healthz').then(r => { if (!r.ok) process.exit(1) }).catch(() => process.exit(1))"

ENTRYPOINT ["node", "build/index.js"]
