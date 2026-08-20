FROM mongo:7 AS mongo-tools

FROM node:20-slim

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends openssh-client ca-certificates libcurl4 libgssapi-krb5-2 tar \
  && rm -rf /var/lib/apt/lists/*

COPY --from=mongo-tools /usr/bin/mongodump /usr/local/bin/mongodump
COPY --from=mongo-tools /usr/bin/mongorestore /usr/local/bin/mongorestore

COPY core/package*.json ./
RUN npm ci --omit=dev

COPY core/ ./
COPY shared/ /shared/
RUN npm run build && rm -rf tests coverage .env .env.* .git

EXPOSE 3080

ENV NODE_ENV=production
ENV PORT=3080

CMD ["node", "server.js"]
