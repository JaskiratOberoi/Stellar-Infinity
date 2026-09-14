FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/app/data

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY server.mjs ./
COPY lib ./lib
COPY public ./public
COPY assets ./assets

# Sealed reports and the signing secret live here; mount it to keep them.
RUN mkdir -p /app/data && chown -R node:node /app
USER node
VOLUME ["/app/data"]

EXPOSE 8080
CMD ["node", "server.mjs"]
