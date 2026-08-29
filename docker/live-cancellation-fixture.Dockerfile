FROM node:20.20.2-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0

WORKDIR /app

COPY e2e/fixtures/live-cancellation-ollama.js /app/live-cancellation-ollama.js
COPY e2e/run-live-cancellation.js /app/run-live-cancellation.js
COPY e2e/live-cancellation-receipt.js /app/live-cancellation-receipt.js
COPY benchmark/package.json /benchmark/package.json

USER node

CMD ["node", "/app/live-cancellation-ollama.js"]
