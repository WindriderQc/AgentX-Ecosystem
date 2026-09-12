# Trusted extensions

Agent X Core exposes one deliberately small in-process seam for separately
owned trusted extensions. The seam lets an operator add a private application
without forking Core or duplicating inference, routing, streaming, telemetry,
PromptConfig, or conversation persistence.

Use this seam only when the component must share Core's process and injected
conversation contracts. An application that owns its UI,
authentication, private state, conversations, privacy policy, or release
lifecycle should normally run independently and use the versioned
[external consumer API](EXTERNAL_CONSUMERS.md) for stateless routed inference.
That boundary also lets the application support an explicit direct-provider
mode without making Agent X part of its availability or storage boundary.

No extension is bundled or enabled by the product. The default `demo` profile
never loads extensions. Loading requires all of the following:

1. `AGENTX_PROFILE=full`;
2. `AGENTX_EXTENSION_MODULES` set to one absolute module path or a JSON array
   of absolute module paths;
3. a separately installed, operator-pinned module.

Coding integrations can use `runtimeServices.pipeline.read(pipelineId)` and
`pipeline.apply({ pipelineId, expectedUpdatedAt, automation?, question?, answer?,
plan? })` to prepare a queued or blocked ticket. Core owns these Mongo writes,
normalizes new automation intent and rejects concurrent changes, live leases,
other workers' ownership and personal/household tasks. Preparation never resets
attempts or changes an attempted task's scope. Repository policy and planning
remain deployment-owned; execution uses the existing atomic claim contract.

Example operator configuration:

```text
AGENTX_PROFILE=full
AGENTX_EXTENSION_MODULES=["/opt/agentx-extensions/private-application"]
```

The module exports a synchronous manifest:

```js
module.exports = {
  id: 'private-application',
  version: '1.0.0',
  capabilities: ['private-application'],
  register({
    contractVersion,
    app,
    express,
    mongoose,
    logger,
    standardJsonParser,
    conversationLifecycle,
    runtimeServices,
    extensionRoot
  }) {
    const router = express.Router();
    router.get('/status', (_req, res) => res.json({ ok: true }));
    app.use('/api/private-application', standardJsonParser, router);
  }
};
```

Contract version 2 provides the Express application, Express and Mongoose
instances already used by Core, the Core logger and standard JSON parser, the
active runtime profile, the extension's resolved root, and the versioned
`conversationLifecycle` and `runtimeServices` services. Additive
Core services carry their own contract version so extension startup can fail
closed when a required bounded interface is unavailable. Extensions may create
their own collections; Core-owned transcript lifecycle must go through
`conversationLifecycle`, never direct collection access.

Every conversation lifecycle operation is scoped by both `userId` and
`promptName`. Its current capabilities are:

- list and get conversations, including explicitly requested transcripts;
- verify prompt ownership and list scoped IDs;
- rename, archive, restore, and permanently delete conversations.

`runtimeServices` contract version 1 exposes three frozen capabilities:

- `inference.execute(request, { signal })` executes chat, generate, or embedding
  work through Core-owned routing, benchmark-claim admission, resident-model
  context policy, telemetry, and the operator-selected Ollama runtime. It
  returns actual routed model/host metadata. Streaming returns the upstream
  readable `stream` and a `completion` promise. Before admission, the caller's
  `AbortSignal` cancels the request. Once a stream is admitted, cancellation
  stops delivery: the caller
  must continue consuming it through EOF, discarding cancelled content. Core
  keeps the body deadline and releases the host only after the exact terminal
  record; cancelled responses never count as delivered successes. Destroying
  the stream before EOF leaves the host's terminal state unknown. Readable EOF
  alone does not prove admission settlement or local slot release. Consumers
  must drain the stream and await `result.completion` before acknowledging that
  an interrupted turn has finished or dispatching a dependent turn. Start
  reading before awaiting completion; backpressure may otherwise stall the stream.
  The promise resolves with a frozen terminal receipt (`completed: true`,
  `terminalComplete: true`, and observed usage counters) only after admission
  completion and local release both succeed. A caller cancellation followed by
  successful drainage still resolves this receipt; delivery telemetry remains
  cancelled. Unverified drainage, quarantine, admission settlement failure, or
  release failure rejects with `RUNTIME_INFERENCE_COMPLETION_FAILED` (503), even
  when readable EOF was clean. Failure settles after the existing abandonment
  and release attempts; it never authorizes another dependent turn. Existing
  consumers may ignore the additive promise without an unhandled rejection.
  Buffered results, including HTTP rejections, retain their existing contract.
  Trusted callers may opt into `retry: { enabled: true }`, with `beforeAttempt`
  to revalidate their existing task and `onProgress` to project bounded state.
  Core fixes the route and payload before retrying: at most six inference
  attempts in a 120-second retry window, exponential waits from 2 to 30 seconds,
  respecting longer `Retry-After` values without exceeding the window or caller
  deadline. Active reservations and proven pre-send connection failures can
  retry; exact Ollama 429/503 rejection objects can retry after settlement.
  Unclassified conflicts, invalid proof/configuration, UNKNOWN reservations,
  resets/timeouts after an uncertain send, and partial streams cannot. Retrying
  never includes harness tools, changes the model/provider, or restarts a task.
  Progress/terminal evidence carries the cause and bounded retry history;
  telemetry remains one record per logical call. A process restart does not
  reconstruct/replay the request; a consumer must explicitly recover its session.
- `routing.getEffectiveSnapshot(options)` returns an immutable, read-only view
  of effective task routing, host preferences, resolved context/capability
  evidence, and an optional active-model catalog. It does not expose mutable
  collections.
- `hosts.acquireHold / touchHold / releaseHold / getHoldStatus` keep one model
  resident on one configured host for an interactive session. `acquireHold`
  takes `{ hostUrl, owner, model, idleTtlMs?, note?, numCtx?, warm? }`, is
  idempotent for the same owner, and starts the warm-up through the same
  exclusive admission path a held turn uses. `numCtx` is the context the
  session's turns will request: the warm-up loads the model at that context
  and residency is judged against the context Ollama reports, so the first
  held turn does not reload the model at a different context. Without it the
  model loads at its Modelfile context and residency is by name only. While the hold is active Core does not
  restore the displaced pin, refuses inference on that host for any other
  model with `503 HOST_SESSION_HOLD_ACTIVE` (the error carries
  `retryAfterMs`; HTTP generation also returns `Retry-After`, `holdModel`, and
  `holdExpiresAt`), and refuses benchmark claims. This is a retryable busy
  response, not a server queue. Every `touchHold` pushes the
  expiry forward by the idle window (60 s to 6 h, default 10 min). Release or
  idle expiry forfeits the remaining pin grace. Explicit release requests an
  immediate reconciler cycle, and any already-running warm-up requests another
  on completion. Startup pin warming and restoration use exclusive admission
  on the affected host; another host's quarantined inference does not block
  them. Global maintenance and conflicts on that same host still apply.
  Core's startup pin warm, the watchdog, and the Nerve Center
  reload button also skip a held host (`skipped_hold`), and a status read on an
  active hold whose model is no longer resident re-warms it, so a hold survives
  a Core restart. `getHoldStatus` reports the hold, live residency from
  Ollama, and the warm-up phase (`none`, `loading`, `resident`, `error`,
  `pending`) so a surface can show that the model is still loading. Host
  contention stays pending and retries on subsequent status reads. After
  release, `restoration.phase` is `waiting`, `loading`, or `ready`; a pin still
  visible during an unfinished session warm-up is not reported as restored. The
  `hosts` capability is additive: an extension that does not find it must
  degrade, not fail startup.

Before provider generation, the executor preserves `503` admission refusals as
`RUNTIME_INFERENCE_ADMISSION_DENIED`, `RUNTIME_INFERENCE_RECOVERY_REQUIRED`,
`BENCHMARK_CLAIM_ACTIVE`, or `BENCHMARK_CLAIM_PROOF_INVALID`. These codes also
remain in inference telemetry. They describe host state or reservation proof,
not a provider network outage. Extensions should preserve that distinction in
their protocol and recovery behavior. Actual transport failures remain
`502 INFERENCE_UPSTREAM_UNAVAILABLE`; timeouts and cancellations retain their
existing classifications.

The executor accepts only the bounded local request surface documented by its
mode and rejects runtime-placement options. A matching resident pin owns
context and keep-alive. Extensions translate their external protocol into that
surface; they do not choose an inference host, call an Ollama server directly,
or copy HostPreference logic. External-provider implementations and their
credentials remain outside the product repository and this runtime contract.

Paths must be absolute and are resolved before loading. Invalid manifests,
duplicate real paths, duplicate IDs, duplicate capability ownership, or
asynchronous registration fail startup. Registration occurs before built-in
routes, so extensions can install middleware in front of Core-owned paths.

An extension may also contribute a small full-profile operator entry point by
setting `app.locals.trustedRuntimeNavItems` during registration. Product accepts
at most eight unique items with this shape:

```js
app.locals.trustedRuntimeNavItems = [{
  id: 'private-runtime',
  label: 'Private Runtime',
  href: '/api/private-runtime/control-launch',
  icon: 'fa-terminal',
  // optional, bounded: who provides the door, and one sentence for its tooltip
  owner: 'Deployment',
  description: 'Private runtime launched through this deployment. Opens in its own tab.'
}];
```

The contract lives in `shared/trustedRuntimeNavigation.js`. Core validates the
list on every rendered request. IDs and Font Awesome icon classes are bounded,
`href` must be a same-origin `/api/...` launcher, `owner` is at most 24
characters and `description` at most 160 with no location in it. Direct
external URLs, script URLs, malformed fields, and duplicates are dropped.

The validated list is republished as `navigation.trustedRuntimeNavItems` in
`GET /api/config` (empty in the demo profile). Benchmark and RAG read it from
the same cached Core config they already use for public URLs, so every full
Product service renders the same `Operate → External runtimes` entries and the
portal lists the same launchers under `External runtimes`, each opening in its
own tab with its provider tag. Off-Core services prefix the launcher with the
configured Core authority; Product never hardcodes a private destination. The
launcher remains responsible for operator access, safe handoff, and any
external runtime authentication, including any launch preflight it offers.

Agent Ops runtime projections may similarly provide a `launchUrl` on a runtime
layer. The shell treats it as the runtime-owned destination; the AIOps adapter
still owns validation and access control for that URL.

Extensions run with Core's process privileges. Treat them as deployment code:
review and pin them independently, mount them read-only, and never load an
untrusted checkout. Extension source, secrets, mounts, and deployment remain
outside this repository. The product's Compose defaults include none of them.

This is not a marketplace, discovery system, second router, or operations
framework. Core owns only the loader and injected contracts; each extension
owns its application behavior and data.
