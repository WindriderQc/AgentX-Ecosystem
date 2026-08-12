---
id: "0099"
title: "env override for model pin"
status: queued
owner: "clawdx-coder"
created: 2026-04-15
---

**Objective:** allow `OLLAMA_MODEL_PIN` env var to override the pinned model in `modelRoutingService.js`.
**Files:** src/services/modelRoutingService.js
**Acceptance:** env var, if set, wins over config default.
