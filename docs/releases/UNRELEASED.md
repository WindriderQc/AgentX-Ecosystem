# Agent X Ecosystem — Unreleased

- **Apply quick preset** is a secondary settings action. The floating
  **Launch Benchmark** shortcut appears only while the main launch button is
  outside the viewport. All workload estimates use the current eligible model
  selection, prompt depth and repeat count, including after saved settings load.

- Benchmark keeps progress, final results and failure reasons visible until
  **New comparison** is selected. Completed, failed, stopped and interrupted
  runs no longer return to configuration after three seconds. Late updates
  from a previous run cannot replace the current comparison.

- Pipeline adds a status board and recorded timeline for existing task groups,
  with adjacent filters and dossier access. Launch controls sit with the detailed
  queue; human decisions, completed deliveries and scoped attempt statistics
  have distinct sections. Slow delivery evidence no longer blocks task loading
  or shifts the page. See [Pipeline](../PIPELINE.md).

- Pipeline has one create/edit form with freeform descriptions, optional planning
  fields and local LLM proposals reviewed before saving. Concurrent edits keep
  the user's draft; status, ownership and receipts stay intact.
  See [Task editing](../PIPELINE_EDITOR.md).

- On phones, Chat history uses the available width instead of squeezing the
  conversation into a narrow column. Close History to return to the conversation.

- Quick comparison checks the same inference contracts as execution before
  applying settings. Both models use a verified common context of at most
  8,192 tokens, thinking off, and speed measured during the run. Large profiler
  measurement windows no longer become unverified execution settings.

- Chat history supports Rename and Delete through the existing owner-scoped
  history API. Renaming preserves messages; deleting removes only the selected
  visible conversation. Rejected requests show an error and retain the current
  chat instead of reporting success.

- Indexed source passages wrap within compact screens even when their document
  metadata table needs horizontal scrolling. Expanding a passage keeps its text
  readable without panning across the table.

- Compare models is a direct navigation destination on Core, Benchmark and
  Knowledge. The Knowledge menu now follows the same Add knowledge, Ask your
  knowledge and Browse sources journey as its pages and demo guide.

- Memory Review can resume a retryable synthesis failure through the existing
  finalize action, preserving its accepted observations, collection watermarks,
  dedup context and failure audit. Resuming does not approve or apply candidates.

- Session hold release requests immediate pin reconciliation and reports
  restoration progress. Host contention stays pending and retries. Startup
  warm and pin restore use existing exclusive host admission, so another
  host's quarantined inference cannot block them. Held-model HTTP rejections
  preserve retry timing, and startup logs recognize already-loaded pins.

- Host session holds may carry the context their turns will request
  (`acquireHold({ numCtx })`). The hold's warm-up loads the model at that
  context, the persisted hold keeps it for later re-warms, and residency is
  judged against the context Ollama reports (`residentContextLength` in the
  hold status). Omitting it keeps the previous by-name behaviour.

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
