# Agent X product instructions

This is the product repository, not the AIOps operations repository.

## Current truth order

1. `README.md` and `docs/ARCHITECTURE.md` define the supported product.
2. `docker-compose.yml`, `config/agentx.env`, and health endpoints define the
   default runtime.
3. Service code and tests define implementation contracts.

Never infer current runtime, required hosts, or product scope from an AIOps
audit, migration note, generated report, RAG memory artifact, old checkout, or
cached index. Historical and operational documents do not belong here.

## Boundary rules

- Core, Benchmark, RAG, and `shared/` are product-owned.
- MongoDB and Qdrant are internal runtime dependencies.
- Ollama is optional and user-selected; no model download is implicit.
- OpenClaw, Hermès Agent, OctoPrint, and other environment-specific adapters
  live outside this repository and may consume bounded product APIs.
- Do not add an embedded adapter implementation, adapter loader, operations
  extension framework, or private runtime fallback to this product.
- Data/AIOps operations, personal mounts, secrets, and production addresses do
  not belong in the default runtime.
- A private Data service may be called only through a separately operated,
  bounded read-only API; it is not an Agent X skill or product service.
- Dreaming is a Core product capability and remains in this repository.
- Never commit `.env`, credentials, personal data, model volumes, caches, or
  generated test/build output.

Before changing the boundary, render Compose, scan it for external endpoints
and bind mounts, run the focused profile tests, and verify the affected health
contracts.
