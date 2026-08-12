FROM node:20-slim

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates libcurl4 \
  && rm -rf /var/lib/apt/lists/*

COPY benchmark/package*.json ./
RUN npm ci --omit=dev

COPY benchmark/ ./
COPY shared/ /shared/

COPY core/views /core/views
COPY core/public /core/public
RUN mkdir -p /core/public/dist
COPY core/src/frontend/shared-tokens.css /core/public/dist/shared-tokens.css
COPY core/src/frontend/shared-utils.js /core/public/dist/shared-utils.js

RUN mkdir -p /app/config-data \
  && ln -sf /app/config-data/benchmark.config.json /app/benchmark.config.json \
  && rm -rf tests coverage test-results scripts .env .env.* .git

EXPOSE 3081

ENV NODE_ENV=production
ENV PORT=3081

CMD ["node", "server.js"]
