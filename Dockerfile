FROM node:22-alpine

# openssl is used to generate a self-signed certificate on first start
RUN apk add --no-cache openssl

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

COPY src ./src
COPY public ./public
COPY views ./views

ENV NODE_ENV=production \
    DATA_DIR=/data

VOLUME /data
EXPOSE 8080 8443

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:9000/healthz >/dev/null || exit 1

CMD ["node", "src/server.js"]
