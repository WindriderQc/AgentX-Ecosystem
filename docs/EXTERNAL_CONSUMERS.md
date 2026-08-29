# External consumer API

Agent X Core exposes one small, versioned HTTP contract for independently
deployed applications that want routed inference without running inside Core.
The contract is application-neutral: Core chooses the effective model host,
applies its resident-model and benchmark-admission policies, and records
inference telemetry. The application owns its UI, authentication, prompts,
conversations, persistence, privacy policy, and release lifecycle.

The v1 base path is `/api/consumers/v1`; discovery is
`GET /api/consumers/v1/capabilities`. The advertised contract identity is
`agentx.external-consumer` version `1.0.0`. `GET /health` remains the Core
liveness/readiness endpoint.

Every v1 response includes `X-AgentX-Consumer-Contract: 1.0.0`. Discovery and
routing include fresh `generatedAt` evidence, and the routing projection is a
strict allowlist: absolute URLs and runtime location fields never cross the
consumer boundary.

## Authentication

A separately deployed application uses the route-scoped credential configured
on Core as `AGENTX_EXTERNAL_CONSUMER_TOKEN`. Supply it as either:

```text
Authorization: Bearer <token>
```

or:

```text
X-AgentX-Consumer-Token: <token>
```

Headerless loopback calls remain available for local development. Non-loopback
calls fail closed when the scoped token is absent or invalid. The existing
operator token is accepted as an administrative path, but applications should
not receive that broader credential. The external-consumer token does not
authorize unrelated operator routes.

Secrets and deployment addresses stay outside this repository. A consumer
typically receives `AGENTX_BASE_URL` and the scoped token from its own runtime
environment.

## Effective routing snapshot

`GET /api/consumers/v1/routing` returns the task types that the active Core can
route. Each task contains the exact effective model, an opaque host key,
availability, host state, context evidence, and qualification state. It never
returns host URLs, deployment defaults, mutable database documents, or raw
topology errors. The snapshot is read-only and uses `Cache-Control: no-store`.

Consumers use this endpoint for capability display and readiness decisions;
they do not copy the routing table or call a discovered Ollama host. Sending a
`taskType` delegates model and host selection to Core. Sending an exact `model`
asks Core to select the configured host for that artifact. There is no host
selector in this contract.

## Inference

`POST /api/consumers/v1/inference` accepts JSON up to 1 MiB. A routed chat
request is:

```json
{
  "consumer": "example-app",
  "mode": "chat",
  "taskType": "general_chat",
  "messages": [
    { "role": "system", "content": "Application-owned instructions." },
    { "role": "user", "content": "Hello." }
  ],
  "stream": false,
  "persist": false,
  "think": false,
  "options": {
    "temperature": 0.7,
    "num_predict": 600
  }
}
```

`mode: "generate"` uses a required `prompt` string and an optional `system`
string instead of `messages`. At least one of `taskType` or an exact `model` is
required; if both are supplied, the exact model is used and the task type is
retained as request metadata.

`consumer` is a bounded lowercase application identifier. Core constructs the
telemetry label `external/<consumer>` itself. Caller-supplied `callerDetail`,
host, lane, routing, or authentication fields are never forwarded, so an
application cannot claim a privileged inference lane.

The supported generation options are `num_predict`, `temperature`, `top_p`,
`top_k`, `min_p`, `seed`, `stop`, `repeat_penalty`, `presence_penalty`, and
`frequency_penalty`. Values are range checked. Context, placement, and runtime
authority such as `num_ctx` or `num_gpu` are rejected because Core owns the
effective runtime contract. `think` is an optional boolean; named thinking
modes are not part of v1.

A successful non-streaming response uses the normal Agent X envelope:

```json
{
  "ok": true,
  "status": "success",
  "data": {
    "message": { "role": "assistant", "content": "Hello." },
    "text": "Hello.",
    "usage": { "promptTokens": 12, "completionTokens": 4 },
    "done": true,
    "route": {
      "requestedModel": null,
      "taskType": "general_chat",
      "model": "exact-installed-tag",
      "hostKey": "opaque-host-key",
      "routingSource": "task_router",
      "inferenceContract": {
        "version": 1,
        "contextWindowTokens": 32768,
        "contextSource": "profile",
        "qualification": { "state": "qualified", "qualified": true }
      }
    },
    "persistence": { "persisted": false }
  }
}
```

The same route identity is available in `X-Resolved-Model`,
`X-Routed-Host-Key`, `X-Routing-Source`, and `X-Routing-Task-Type`. Host URLs
are deliberately absent.

## Streaming and cancellation

Set `stream: true` to receive `text/event-stream`. Events are emitted in this
order:

```text
event: route
data: {"model":"exact-installed-tag","hostKey":"opaque-host-key"}

event: delta
data: {"text":"partial response","role":"assistant"}

event: done
data: {"usage":{"promptTokens":12,"completionTokens":4},"persistence":{"persisted":false}}
```

Failures after streaming begins use an `error` event with `code` and `message`.
Closing the client connection aborts the Core-owned upstream request and
releases its admission slot. Consumers should therefore cancel the HTTP
request when their user stops generation; no separate cancellation endpoint
or request registry exists.

## Stateless boundary

The external consumer API never calls Core conversation lifecycle or transcript
storage. `persist: false` may be sent as an explicit assertion; `persist: true`
is rejected. An application must store, archive, export, and delete its own
conversations. This also means application prompts and private longitudinal
state never need to enter Agent X persistence.

The contract has no silent direct-Ollama fallback. A standalone application
may implement a separate direct provider, but provider selection and fallback
policy belong to that application and must remain explicit.
