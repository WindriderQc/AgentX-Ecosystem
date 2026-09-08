# Inference execution

Core owns model execution; a caller owns its conversation, prompt construction
and delivery protocol. HTTP handlers do not need to call Core over localhost to
generate a response.

`src/services/inferenceService.executeInference(body, context)` is the direct
equivalent of `POST /api/inference/generate`. It returns `{ ok, status, body,
headers }`, or `undefined` after caller cancellation. The HTTP adapter resolves
caller attribution, connects its disconnect signal, and presents that result.
The service owns route selection, exact-artifact validation, attempt telemetry,
and the existing optional degraded retry. Neither it nor its retry presenter
accepts an Express request or response.

`inferenceRuntimePolicy.prepareInferenceRuntime` resolves pins, context budget,
output limits and thinking. Its caller policies preserve these existing
differences:

| Caller policy | Pins and residency | Output limit | Thinking |
|---|---|---|---|
| Generation | Exact tag; matching pin owns residency | Contract reserve unless caller supplied a value | Core policy |
| Direct evaluation | Caller options; no pin lookup | Caller value | Core policy with direct/raw metadata |
| Chat | Normalized pin match; caller residency wins | Caller value | Core interactive policy |
| Injected consumer | Normalized pin match; matching pin owns residency | Contract reserve unless caller supplied a value | Native caller value |
| Injected embeddings | Same pins as injected consumers | No generation limit | Not a generation operation |

Every policy preserves explicit context and output values and the requested
model artifact. `useAdapted` remains retired. These names select implementation
behavior; they introduce no authentication or new runtime gate.

`routing/inferenceAttemptExecutor.executeAdmittedOllamaAttempt` owns the
non-stream attempt: distributed admission, host slot, optional exclusive model
preparation, cancellation, fetch, body completion and settlement. HTTP generation,
chat, injected generation/chat/embeddings, classification and non-stream
Roundtable attempts use this executor. An exclusive preparation that unloads a
model is already dispatched work and keeps the same admission generation fence.
Injected consumers retain strict validation of Ollama rejection bodies.

Each caller records its existing telemetry shape exactly once per attempt.
The attempt executor does not add a second row. Generic fallback records its
own second attempt and remains subject to the existing caller policy.

Nestor, external consumers and separately installed voice/household/protocol
adapters continue to use `runtimeServices.inference.execute`. Their business
behavior and source remain outside this execution layer. Legacy Buddy/voice
Product routes are compatibility shims, not another inference implementation.

`routing/inferenceStreamExecutor.executeAdmittedOllamaStream` uses the same
admission and host-slot preparation for Chat, Council/Roundtable and injected
consumers. Its relay preserves native NDJSON bytes, observes bounded UTF-8
frames, and settles only after an exact final `done` record and upstream EOF.
Malformed, oversized, post-terminal or incomplete streams cannot release an
admission as successfully completed. The deadline covers headers and body;
settlement releases the local slot once. Callers retain their SSE/NDJSON
presentation, conversation persistence and single telemetry entry.

Chat stops delivery on cancellation while draining dispatched upstream work.
Injected consumer streams cancel upstream and quarantine unverified completion.
Council keeps its existing whole-attempt deadline. No streaming executor retries
or substitutes a model. The buffered `stream: true` generation endpoint keeps
its existing JSON contract; embeddings remain buffered on `/api/embed`.

Benchmark batch and single evaluation already call Core's direct execution
lane. That lane keeps the requested model, host and options and never enters
degraded fallback, even if the request also carries an interactive task label
and opts into fallback. External OpenClaw and local Hermès adapters continue
through the injected contract; their fixed execution chain stays caller-owned.

## Direct transport inventory

These are the remaining intentional direct operations, not alternate everyday
conversation paths. This inventory is documentation, not a new runtime gate.

| Operation | Owner and reason |
|---|---|
| Model discovery: `tags`, `show`, `ps`, version | Runtime metadata and readiness; no generated answer |
| Load/unload, warmup, watchdog and recovery | Runtime management with operation-specific coordination |
| Benchmark batch and single evaluation | Core direct lane; fixed artifact and options, no adaptive retry |
| `benchmark/src/services/benchmark/cloudLaneTransports.js` | Explicit qualification campaign transport, used by `benchmark/scripts/cloud-lane-campaign.js`; exact local candidate and fixed payload, no fallback. CLI defaults to a plan with zero network calls. |

Read-only model discovery (`tags`, `show`, `ps`, version), model load/unload,
watchdog probes and recovery are runtime operations. They are not conversational
generation callers and must retain their operation-specific coordination.

Contract tests compare direct and HTTP generation responses and upstream
payloads, pin/caller precedence, exact terminal evidence, split UTF-8, stalled
bodies, cancellation, exclusive handoff, fixed-mode failures and telemetry
counts. They use disposable test infrastructure and do not require a model
profile or a production database.
