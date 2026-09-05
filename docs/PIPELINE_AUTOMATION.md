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

## Performance evidence

A lease-bound terminal feedback call may include an
`agentx.pipeline-automation-evidence/v1` receipt. It carries only bounded
verification status and duration, changed file/byte counts, observed execution
duration and an atomic cost-evidence quartet: integer nanodollars, a supported
cost kind (`provider-spend` or `session-estimate`), kind-matched allowlisted
source, and SHA-256 evidence fingerprint. All four cost fields are present or
all four are `null`; arbitrary sources and mismatched kind/source pairs fail closed.
The receipt also carries normalized failure codes and an optional generic WorkerReceipt
fingerprint. It never carries prompts, transcripts, file paths, tool payloads,
hostnames, provider credentials, or raw billing records. Partial evidence is
valid: every unobserved metric remains `null`, never zero.

An operator may reconcile a completed attempt whose cost was initially unknown
through `POST /api/pipeline/tasks/:id/automation-attempts/:attempt/cost`. The
operation is write-once and requires an exact integer nanodollar value, supported
cost kind, bounded source, SHA-256 evidence fingerprint, and reviewer identity. It cannot overwrite
or contradict an existing cost and records a feedback audit entry.

The scorecard never treats local inference as free compute. A locally routed
attempt may prove external provider spend of zero while local compute remains
unpriced. Historical OpenClaw session amounts are labeled billing-unverified
session estimates. Mixed kinds are shown separately and are never summed into a
single authoritative total.

Human confirmation or re-queue records the review decision and timestamp on
the exact attempt. `GET /api/pipeline/performance?window=7d|30d|90d` aggregates
throughput, acceptance, first-pass share, corrective interventions, timing,
cost, change volume, safety blocks, and evidence coverage from Mongo task
history. Rates exclude unknown samples and always publish their coverage.
Pipeline renders the same projection in its Coding Team scorecard and attempt
timeline; it does not infer worker value from activity alone.

## Trust boundary

The automation intent is authorization input, not proof that a task is safe or
that a worker is qualified. A deployment-owned deterministic admission engine
must apply current protected-path, repository, cost, concurrency, and worker
qualification policy. Worker claims and receipts are evidence; independent
verification and a distinct human or delegated reviewer retain acceptance
authority.
