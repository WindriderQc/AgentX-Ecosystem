# Agent X Ecosystem — Unreleased

- Benchmark shows context and response budgets before launch, with live catalog
  lengths for each difficulty level. Scorer 2.9.0 removes implicit reference,
  task and answer clipping; explicit excerpts remain reported consistently.
  Judge calls reject reported upstream input transformations. Warmup releases
  other generators even when the requested judge is already resident.
  See [Context and output budgets](../BENCHMARK_CONTEXT_BUDGETS.md).

- Pipeline dossiers remain above navigation so their title and close button stay
  reachable on desktop and mobile. Morning report sections that fail to load now
  retain null measurements with their existing unavailable marker.

- Pipeline HTTP and MCP creation preserve objectives and optional instructions,
  including partial specs and camelCase field aliases. MCP needs only a title or
  objective. Generated specs omit obsolete credential and environment boilerplate;
  explicit `spec` text remains verbatim. Feedback criterion IDs are strings, as
  expected by worker receipt consumers.

- Routing configuration now has one API family, `/api/router/config`. Migrate
  GET/PUT calls from `/api/nerve-center/routing/config` to that path; the bulk
  write payload is unchanged. The old path and cosmetic POST
  `/api/nerve-center/failover` and `/api/nerve-center/failover/reset` routes are removed. Actual per-request fallback,
  persisted routing evidence and deletion of saved overrides remain supported.

- Core retains the two Benchmark recommendation endpoints used by Models and
  removes the generic Benchmark proxy. Integrations that used other
  `/api/benchmark-proxy/*` paths must call Benchmark's `/api/benchmark/*` API at
  its configured service URL. Leaderboards, batches and results remain available
  directly in Benchmark.

- Chat, Council and injected consumers share streaming execution, deadline and
  completion handling while preserving their delivery and cancellation behavior.
  Fixed Benchmark execution cannot fall back to another host or model, even
  when its request has an interactive task label.

- Chat's controls title and close button remain visible above navigation,
  including on compact screens.

- Core generation can run directly without an HTTP self-call. Generation, chat
  and injected non-stream consumers share runtime preparation and admitted
  execution while preserving their model, residency, cancellation and telemetry
  contracts. See [Inference execution](../INFERENCE_EXECUTION.md).
- Results now compare the selected prompts and answers directly, with sample
  counts, scoring sources, timing, missing-answer states, and expandable run
  details. The Prompt column helps find matching tasks. The comparison adapts to
  compact screens and supports keyboard dismissal and focus restoration.
- The existing image publisher can promote stable version aliases from an
  already-published commit without rebuilding images or moving latest.

See [v0.2.0](v0.2.0.md) for Quick comparison, Chat and Knowledge improvements,
private-LAN simplification, upgrade implications, and known limitations.
Add subsequent changes here; published release notes remain historical records.
