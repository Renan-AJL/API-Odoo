FROM node:20-alpine

LABEL maintainer="odoo-middleware-unified"
WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY config/ ./config/
COPY middleware/ ./middleware/
COPY routes/ ./routes/
COPY services/ ./services/
COPY utils/ ./utils/
COPY assets/ ./assets/
COPY server.js ./

EXPOSE $PORT

ENV NODE_ENV=production
ENV PORT=3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:$PORT/api/v1/health || exit 1

CMD ["node", "server.js"]