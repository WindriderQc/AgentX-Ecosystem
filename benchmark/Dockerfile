FROM node:20-slim

WORKDIR /app

# Copy package files first for better cache
COPY package*.json ./
RUN npm ci --production

# Copy source
COPY . .

# Remove dev/test artifacts while keeping the production data migration used
# by the exact-artifact profiling runbook.
RUN find scripts/ -type f ! -name 'migrate-exact-artifact-profile-indexes.js' -delete \
    && rm -rf tests/ test-results/ .env .env.* gift/

EXPOSE 3081

ENV NODE_ENV=production
ENV PORT=3081

CMD ["node", "server.js"]
