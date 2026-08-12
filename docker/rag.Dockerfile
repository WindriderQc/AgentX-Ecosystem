FROM node:20-slim

WORKDIR /app

COPY rag/package*.json ./
RUN npm ci --omit=dev

COPY rag/ ./
COPY shared/ /shared/
COPY config/rag-ingestion-policy.json /config/rag-ingestion-policy.json

COPY core/views /core/views
COPY core/public /core/public
RUN mkdir -p /core/public/dist /data/imports
COPY core/src/frontend/shared-tokens.css /core/public/dist/shared-tokens.css
COPY core/src/frontend/shared-utils.js /core/public/dist/shared-utils.js

RUN rm -rf tests coverage logs .env .env.* .git

EXPOSE 3082

ENV NODE_ENV=production
ENV PORT=3082
ENV OBSIDIAN_VAULT_POLICY_PATH=/config/rag-ingestion-policy.json

CMD ["node", "server.js"]
