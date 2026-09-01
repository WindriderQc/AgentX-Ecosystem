# Pipeline automation contract

AgentX exposes generic task admission and evidence primitives. It does not own
an environment's repositories, protected paths, worker hosts, verification
commands, credentials, scheduling, merge policy, or deployment authority.

The existing manual pipeline remains the default. A task is considered for
autonomous execution only when it carries a valid
`agentx.pipeline-automation/v1` intent with `mode: review_only` and explicit
`risk: low`.

## Task intent

```json
{
  "risk": "low",
  "automation": {
    "schema": "agentx.pipeline-automation/v1",
    "mode": "review_only",
    "policyRef": "deployment.low-risk-code/v1",
    "dataClassification": "internal",
    "operations": ["create", "update"],
    "scope": ["core/src/example.js", "core/tests/example.test.js"],
    "lockKeys": ["repo:core/example"],
    "executionProfile": "workspace-write-no-network/v1",
    "verificationProfile": "core-unit/v1",
    "budgets": {
      "maxDurationMs": 900000,
      "maxAttempts": 2,
      "maxCostNanodollars": 0
    },
    "humanGates": ["review", "merge", "deploy"]
  }
}
```

Creation normalizes set-like fields and stores a SHA-256 fingerprint over the
normalized intent. Repository paths must be relative POSIX paths; absolute,
ambiguous, duplicate, and traversal paths fail closed. `review_only` always
requires human review, merge, and deployment gates. Deployment-owned policy is
responsible for rejecting protected scope, disallowed data classifications,
deletion, unavailable worker/verifier profiles, overlapping locks, and budgets
above its local ceilings.

Legacy tasks with no `automation` field keep their existing manual claim and
feedback behavior. `GET /api/pipeline/tasks/next?automation=review_only`
returns only Product-admissible low-risk tasks; deployment policy must still
apply its local gates before dispatch.

A guarded remote worker may read one exact non-personal task through
`GET /api/pipeline/tasks/:id/worker?agent=:identity` using the purpose-scoped
pipeline token. The route returns queued unassigned work or an in-progress,
review, or blocked task already assigned to that identity. It does not list the
queue, change
eligibility, or claim the task.

## Lease-bound attempt

An automated caller claims with:

```json
{
  "assignee": "coding-worker",
  "automated": true,
  "leaseDurationMs": 60000
}
```

Core first acquires one atomic global coding slot, then issues the opaque
`automationLease.leaseId`, increments the bounded attempt count, and appends
metadata-only attempt evidence. The slot prevents two dispatcher processes
from claiming different tasks concurrently. A heartbeat for that
claim includes `leaseId` and `assignee`; Core rejects a missing, stale,
mismatched, inactive, or expired lease. A successful or blocked feedback call
also includes `leaseId` plus `leaseAssignee`, so a guard may remain the feedback
author without impersonating the worker identity bound to the lease.

Automated success still maps only to `review`. The assignee cannot confirm its
own task `done`, merge code, or authorize deployment. Review, blocked, and
re-queue transitions release both the task lease and global slot while
retaining the attempt count and bounded attempt history.

## Trust boundary

The automation intent is authorization input, not proof that a task is safe or
that a worker is qualified. A deployment-owned deterministic admission engine
must apply current protected-path, repository, cost, concurrency, and worker
qualification policy. Worker claims and receipts are evidence; independent
verification and a distinct human or delegated reviewer retain acceptance
authority.
