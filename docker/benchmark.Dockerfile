FROM node:20-slim

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY benchmark/package*.json ./
RUN npm ci --omit=dev

COPY benchmark/ ./
COPY shared/ /shared/

COPY core/views/layouts /core/views/layouts
COPY core/views/partials /core/views/partials
RUN mkdir -p /core/public/dist
COPY core/src/frontend/shared-tokens.css /core/public/dist/shared-tokens.css
COPY core/src/frontend/shared-utils.js /core/public/dist/shared-utils.js
COPY core/public/css/platform-chrome.css /core/public/css/platform-chrome.css
COPY core/public/js/utils/polling-controller.js /core/public/js/utils/polling-controller.js
COPY core/public/js/utils/polling-controller-global.js /core/public/js/utils/polling-controller-global.js
COPY core/public/js/utils/shared.js /core/public/js/utils/shared.js
COPY core/public/js/utils/shortcut-hints.js /core/public/js/utils/shortcut-hints.js
COPY core/public/js/utils/shortcuts-modal.js /core/public/js/utils/shortcuts-modal.js
COPY core/public/js/utils/toast.js /core/public/js/utils/toast.js

RUN mkdir -p /app/config-data \
  && ln -sf /app/config-data/benchmark.config.json /app/benchmark.config.json \
  && find scripts -type f \
    ! -name 'migrate-exact-artifact-profile-indexes.js' \
    ! -name 'cloud-lane-campaign.js' \
    -delete \
  && rm -rf tests coverage test-results .env .env.* .git

EXPOSE 3081

ENV NODE_ENV=production
ENV PORT=3081

CMD ["node", "server.js"]
