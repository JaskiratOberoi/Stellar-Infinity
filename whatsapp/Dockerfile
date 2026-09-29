# The WhatsApp sidecar: a linked WhatsApp Web session (whatsapp-web.js drives a
# real WhatsApp Web page in headless Chromium) behind a tiny HTTP API that only
# the Infinity API calls. Same base and Chromium libraries as ../render, for the
# same reasons (see its Dockerfile).
FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    HOME=/home/wa

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates fonts-liberation fonts-dejavu-core \
      libasound2 libatk-bridge2.0-0 libatk1.0-0 libatspi2.0-0 libcairo2 libcups2 \
      libdbus-1-3 libdrm2 libgbm1 libglib2.0-0 libnspr4 libnss3 libpango-1.0-0 \
      libpangocairo-1.0-0 libx11-6 libxcb1 libxcomposite1 libxdamage1 libxext6 \
      libxfixes3 libxkbcommon0 libxrandr2 xdg-utils \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY patch-wweb-pairing-defer.cjs server.mjs ./
# Phone-number pairing needs the same fix the lab's bots carry (see the file).
RUN node patch-wweb-pairing-defer.cjs

# /data holds the linked session (LocalAuth). It is a named volume in compose:
# lose it and the number has to be linked again by scanning the QR.
RUN useradd -m -u 10002 wa && mkdir -p /data && chown -R wa:wa /app /home/wa /data
USER wa

EXPOSE 8095
CMD ["node", "server.mjs"]
