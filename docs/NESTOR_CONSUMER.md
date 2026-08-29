# Nestor consumer API

Agent X Core exposes a bounded, stateless contract for Nestor-style assistants
at `/api/consumers/nestor/v1`. Core owns model routing, host admission,
resident-model policy, and inference telemetry. The consumer owns its persona,
prompt, transcript, memory policy, speech pipeline, end-user authentication
boundary, and user experience. Calls from a separately deployed consumer to
Core use the same route-scoped `AGENTX_EXTERNAL_CONSUMER_TOKEN` documented for
the generic consumer API; headerless calls remain limited to the local product
boundary.

Discovery is `GET /api/consumers/nestor/v1/capabilities`. Contract version
`1.2.0` adds optional streaming to the existing inference endpoint without
changing the default JSON response used by 1.1 clients.

## Inference

`POST /api/consumers/nestor/v1/inference` accepts one of three fixed
operations: `chat`, `react`, or `analyze`. Core maps those operations to the
operator-controlled `buddy_chat`, `buddy_reaction`, and `analysis` task routes.
The consumer cannot supply an arbitrary task type or telemetry caller label.

```json
{
  "operation": "chat",
  "messages": [
    { "role": "system", "content": "Consumer-owned instructions." },
    { "role": "user", "content": "Hello." }
  ],
  "stream": false,
  "options": {
    "num_predict": 400,
    "temperature": 0.8
  },
  "context": {
    "surface": "desktop",
    "sessionId": "consumer-opaque-id"
  }
}
```

`stream` defaults to `false`. The optional `requested.model` selects an exact
model artifact. The optional `requested.host` must resolve through Core's host
allowlist. Omitting both delegates placement to the configured task router.
Core disables thinking output for this speech-safe contract.

The JSON response contains the reply, normalized usage, operation identity,
and routing provenance. The contract is stateless: `sessionId` is returned for
correlation but Core does not persist a transcript.

## Streaming and cancellation

Set `stream: true` to receive `text/event-stream`. Events are ordered as:

```text
event: route
data: {"operation":"chat","taskType":"buddy_chat","callerDetail":"nestor/desktop/chat","sessionId":"consumer-opaque-id","provenance":{"resolved":{"model":"exact-installed-tag","hostKey":"primary"}}}

event: delta
data: {"text":"partial response","role":"assistant"}

event: done
data: {"operation":"chat","reply":"partial response","message":{"role":"assistant","content":"partial response"},"usage":{"promptTokens":12,"completionTokens":2},"persistence":{"persisted":false}}
```

The terminal event is exactly one of `done` or `error`. A stream that closes
without an upstream completion record emits
`INFERENCE_STREAM_INCOMPLETE`; it is never reported as a successful partial
answer. Closing the client connection aborts the Core-owned upstream request
and releases its admission slot. This makes token-to-speech overlap possible
without a separate cancellation registry.

## Other endpoints

- `GET /router` reports the read-only effective routes for the three operations.
- `GET /memory/status` and `POST /memory/search` expose bounded read-only memory adapters.
- `GET /events/stream` relays platform events with in-memory cursor replay.
- `GET /metrics` reports only server-attested `nestor-v1` inference rows.
- `/personality/*` and `/panel-summary` return `ADAPTER_REQUIRED`; private behavior belongs to the consumer.

Every v1 response includes `X-AgentX-Consumer-Contract: 1.2.0`. Router and
memory reads include fresh `generatedAt` evidence. Their public projections are
strict allowlists: host URLs, dependency endpoints, and absolute runtime
locations are removed while opaque host keys and source/reference provenance
remain available.

Request and stream limits are advertised by the capabilities response. Runtime
secrets, deployment addresses, personal prompts, and household policy must not
be committed to this product repository.
