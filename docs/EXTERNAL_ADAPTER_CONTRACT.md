# External adapter consumer contract

Status: product-owned boundary for separately operated consumers.

This contract defines how an independently deployed application may consume
Agent X without becoming part of the product. Hermès Agent, OpenClaw, and
private Data/AIOps deployments are examples only; Agent X does not bundle,
configure, discover, or attest any of them.

The adapter implementation, private behavior, data, prompts, credentials,
network exposure, and release lifecycle stay outside this repository.

An adapter that executes multi-turn external work follows the separate
[worker envelope and receipt contract](WORKER_HARNESS_CONTRACTS.md). The
generic inference allowlist below does not turn Core into that harness and does
not grant direct database, router, credential, or provider access.

## Allowed Agent X surface

For a generic out-of-process adapter, this allowlist is exhaustive:

| Purpose | Method and path | Contract |
|---|---|---|
| Core readiness and build identity | `GET /health` | Additive service-health envelope |
| Discover supported consumer behavior | `GET /api/consumers/v1/capabilities` | `agentx.external-consumer` v1 |
| Read effective, topology-opaque routing | `GET /api/consumers/v1/routing` | External consumer routing schema v1 |
| Execute stateless routed inference | `POST /api/consumers/v1/inference` | External consumer inference v1 |

Request and response schemas are defined in
[External consumer API](EXTERNAL_CONSUMERS.md). An application implementing the
fixed Nestor shape may instead adopt the separate
[Nestor consumer API](NESTOR_CONSUMER.md); it must not combine that contract's
privileges with the generic consumer identity.

Browser traffic, operator pages, internal Docker names, database collections,
and routes discovered from source or network inspection are not consumer APIs.
A trusted in-process module follows [Trusted extensions](TRUSTED_EXTENSIONS.md)
instead; it is not an out-of-process adapter shortcut.

The product intentionally names no private Data/AIOps endpoint. Such a service
may be used only through a separately operated, deployment-owned, read-only
contract with its own explicit allowlist. Agent X does not proxy it, mount it,
load it as a skill, or make it part of product readiness.

## Identity, freshness, and provenance

An adapter must:

- verify Core health identity as `service: agentx-core` and retain `version`,
  `profile`, `revision`, and ISO-8601 `ts` with every observation;
- discover capabilities before using the consumer API, verify contract name
  and a supported version, and fail closed on an unsupported major version;
- retain `generatedAt` from capabilities and routing responses. A cached value
  keeps its original timestamp and is labelled stale when it exceeds the
  deployment's explicit freshness budget;
- preserve the response correlation ID and inference route provenance: exact
  model tag, opaque host key, routing source, task type, and consumer-contract
  version. An opaque host key must never be resolved or displayed as a network
  address;
- treat missing, malformed, future-dated beyond the deployment's clock-skew
  tolerance, or identity-mismatched evidence as unavailable, not healthy; and
- keep private Data/AIOps evidence distinguishable from product evidence. Its
  external contract must provide a source/contract identity, observation time,
  and stable evidence identifier; otherwise the adapter marks it unverified.

Freshness budgets and clock-skew tolerance are deployment policy, not values
stored in this repository. They must be finite and documented beside the
adapter deployment. Consumers must never replace a source timestamp with the
time at which a cached value was read.

## Timeouts and degraded behavior

Every call has finite connect and total deadlines. Health, capability, and
routing reads use short operational deadlines and may receive one jittered
retry because they are idempotent. Inference is not retried automatically: the
v1 contract has no idempotency key, and a retry can duplicate work.

Streaming also uses a finite idle deadline that resets only when a valid SSE
event arrives. TCP activity without a valid event does not prove progress.

An inference deadline must be no longer than the adapter's user-visible SLA.
User cancellation, deadline expiry, or a lost client must close the request so
Core can abort its upstream work and release admission. A stream is successful
only after its terminal `done` event; an `error` event or premature disconnect
is a failed result, never a successful partial answer.

When Core or routing is unavailable, the adapter reports `degraded`,
`unavailable`, or `stale` with the last observation time. It must not:

- show cached evidence as live;
- copy the last routing table into a second router;
- call an Ollama host directly from an opaque route result;
- silently switch model, host, provider, or authentication path; or
- fall back to private Data/AIOps results as if they were product health.

An independently deployed application may offer a separately configured direct
provider, but the user must select that mode explicitly and its evidence must
remain separate from Agent X provenance.

## Authentication and deployment ownership

Non-loopback generic consumer calls use only the route-scoped
`AGENTX_EXTERNAL_CONSUMER_TOKEN`, supplied as a bearer token or
`X-AgentX-Consumer-Token`. Headerless loopback access is for local development.
The broader operator credential must not be distributed to adapters.

The deployment owner supplies the Core base URL, TLS or trusted reverse proxy,
network policy, token injection and rotation, clocks, freshness budgets,
timeouts, logging/redaction, and private-service credentials. None of those
values belongs in source control. Default Compose remains loopback-only and
does not create an externally reachable adapter deployment.

The adapter owns its users, authentication boundary, prompts, transcripts,
private state, retention, privacy policy, and deletion/export behavior. Core's
generic consumer API is stateless and must never be treated as the adapter's
conversation store.

## Forbidden coupling

An external adapter must not:

- import product service code or recreate Core routing, HostPreference,
  benchmark admission, rate-lane, or transcript-lifecycle policy;
- read or write MongoDB, Qdrant, model volumes, logs, caches, or host files;
- scrape product HTML or depend on unversioned UI/operator endpoints;
- submit host, lane, `callerDetail`, topology, persistence, or runtime-placement
  claims that the consumer contract does not accept;
- infer hardware or network topology from model names or opaque host keys;
- automatically ingest private Data/AIOps records into RAG or product storage;
- treat a portable skill as network, filesystem, vault, RAG, or identity
  authority; or
- commit adapter code, private addresses, secrets, personal data, mounts, or
  deployment-specific defaults to this repository.

## Conformance checklist

- [ ] The adapter runs outside the Agent X product deployment.
- [ ] Calls are limited to one documented consumer contract and its health
      endpoint.
- [ ] Capability name/version and Core service identity are validated.
- [ ] Source timestamps and provenance survive caching, logging, and display.
- [ ] Freshness, clock-skew, connect, total, and stream-idle budgets are finite.
- [ ] Only idempotent reads receive a bounded retry; inference does not.
- [ ] Cancellation closes the HTTP request or SSE stream.
- [ ] Stale, degraded, unavailable, and identity-mismatched states remain
      distinct from ready.
- [ ] Routing stays Core-owned; no direct-host or silent-provider fallback
      exists.
- [ ] The scoped consumer token is injected and rotated outside source control.
- [ ] Adapter transcripts and private state remain adapter-owned.
- [ ] Private Data/AIOps access is separately authenticated, read-only, and
      provenance-bearing.
- [ ] No private code, endpoint, secret, mount, or personal data enters this
      repository or default Compose.
