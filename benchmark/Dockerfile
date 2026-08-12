FROM node:20-slim

WORKDIR /app

# Copy package files first for better cache
COPY package*.json ./
RUN npm ci --production

# Copy source
COPY . .

# Remove dev/test artifacts
RUN rm -rf tests/ test-results/ scripts/ .env .env.* gift/

EXPOSE 3081

ENV NODE_ENV=production
ENV PORT=3081

CMD ["node", "server.js"]
