FROM node:20-slim

WORKDIR /app

# Copy package files first for better build cache
COPY package*.json ./
RUN npm ci --omit=dev

# Copy source
COPY . .

# Build client bundles (esbuild) — `prestart` would do this, but we bake it
# into the image so cold-start is fast and no write to /app at runtime.
RUN npm run build || true

# Strip dev/test artifacts
RUN rm -rf tests/ test-results/ scripts/overseer .env .env.* logs/* || true

EXPOSE 3080

ENV NODE_ENV=production \
    PORT=3080

CMD ["node", "server.js"]
