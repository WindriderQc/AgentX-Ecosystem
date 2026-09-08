# Agent X Ecosystem — Unreleased

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
