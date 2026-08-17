FROM node:20-slim

WORKDIR /app

COPY rag/package*.json ./
RUN npm ci --omit=dev

COPY rag/ ./
COPY shared/ /shared/
COPY config/rag-ingestion-policy.json /config/rag-ingestion-policy.json

COPY core/views/layouts /core/views/layouts
COPY core/views/partials /core/views/partials
RUN mkdir -p /core/public/dist /data/imports
COPY core/src/frontend/shared-tokens.css /core/public/dist/shared-tokens.css
COPY core/src/frontend/shared-utils.js /core/public/dist/shared-utils.js
COPY core/public/css/platform-chrome.css /core/public/css/platform-chrome.css
COPY core/public/js/utils/polling-controller.js /core/public/js/utils/polling-controller.js
COPY core/public/js/utils/polling-controller-global.js /core/public/js/utils/polling-controller-global.js
COPY core/public/js/utils/shared.js /core/public/js/utils/shared.js
COPY core/public/js/utils/shortcut-hints.js /core/public/js/utils/shortcut-hints.js
COPY core/public/js/utils/shortcuts-modal.js /core/public/js/utils/shortcuts-modal.js
COPY core/public/js/utils/toast.js /core/public/js/utils/toast.js

RUN rm -rf tests coverage logs .env .env.* .git

EXPOSE 3082

ENV NODE_ENV=production
ENV PORT=3082
ENV RAG_INGESTION_POLICY_PATH=/config/rag-ingestion-policy.json

CMD ["node", "server.js"]
