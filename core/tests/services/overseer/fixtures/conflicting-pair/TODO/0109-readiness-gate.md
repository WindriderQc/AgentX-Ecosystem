---
id: "0109"
title: "gate model selection on readiness"
status: queued
owner: "clawdx-coder"
created: 2026-04-18
---

**Objective:** block routing in `modelRoutingService.js` until the pinned model reports ready.
**Files:** src/services/modelRoutingService.js
**Acceptance:** routing 503s until readiness probe succeeds.
