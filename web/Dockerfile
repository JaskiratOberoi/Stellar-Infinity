# ---- build ----------------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund

COPY . .

# Which environment this bundle is for. Empty in production, so EnvBanner
# renders nothing and its layout offsets never engage. The staging compose file
# passes "staging". Vite only exposes VITE_-prefixed variables to the client,
# and this is read at BUILD time, so it is baked into the bundle rather than
# being something a running container can be talked into changing.
ARG VITE_ENVIRONMENT=""
ENV VITE_ENVIRONMENT=$VITE_ENVIRONMENT

RUN npm run build

# ---- runtime --------------------------------------------------------------
FROM nginx:alpine AS runtime

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80
