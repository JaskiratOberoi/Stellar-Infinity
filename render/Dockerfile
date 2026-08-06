# The report renderer: headless Chromium + pdf-lib.
#
# Debian rather than Alpine: Puppeteer's bundled Chromium is glibc-linked, and
# the musl route means either a hand-installed chromium package that drifts from
# the library's expectations, or a pile of compat shims. The image is bigger and
# it works.
FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    PUPPETEER_SKIP_DOWNLOAD=false \
    # Chromium writes its singleton/profile data here; the default HOME is not
    # writable for a non-root user.
    HOME=/home/render

WORKDIR /app

# Chromium's own runtime libraries. Puppeteer downloads the browser binary but
# not the shared objects it links against, and the failure mode without them is
# a launch that dies with no useful message.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates fonts-liberation fonts-dejavu-core \
      libasound2 libatk-bridge2.0-0 libatk1.0-0 libatspi2.0-0 libcairo2 libcups2 \
      libdbus-1-3 libdrm2 libgbm1 libglib2.0-0 libnspr4 libnss3 libpango-1.0-0 \
      libpangocairo-1.0-0 libx11-6 libxcb1 libxcomposite1 libxdamage1 libxext6 \
      libxfixes3 libxkbcommon0 libxrandr2 xdg-utils \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
# Runs Puppeteer's postinstall, which fetches the matching Chromium build.
RUN npm install --omit=dev --no-audit --no-fund

COPY server.mjs ./
COPY report-assets ./report-assets

# Chromium's sandbox needs privileges this container does not have, so it is
# disabled in the launch flags. That is only acceptable because this service is
# never published and only ever loads our own origin — see the trust note in
# server.mjs. Dropping to a non-root user is the compensating control.
RUN useradd -m -u 10001 render && chown -R render:render /app /home/render
USER render

EXPOSE 8090
CMD ["node", "server.mjs"]
