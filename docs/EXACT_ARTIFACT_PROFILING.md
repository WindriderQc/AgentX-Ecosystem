# Exact-artifact profiling and benchmark admission

Agent X treats an installed Ollama artifact as this tuple:

```text
exact model tag + host + manifest digest + host runtime fingerprint
```

The namespace is part of the tag. `qwen3.5:9b` and `ax/qwen3.5:9b` are two
different artifacts even if their manifests happen to share blobs. The only
name alias normalized by the product is Ollama's implicit `:latest` suffix.

## Authority boundaries

- Ollama `/api/tags` proves the tag and live manifest digest installed on a
  host.
- Core `ModelRegistry.installations[]` records that digest independently for
  every host. Registry sync must complete before profiling.
- Benchmark `ModelProfile` records readiness for the exact artifact identity.
- Benchmark `ModelPerformanceProfile`, `ModelContextProfile`, and context probe
  snapshots hold measured evidence bound to the same digest and runtime
  fingerprint.
- HostPreference owns residency policy such as context, keep-alive, and
  auto-restore. A frozen inference contract owns request-time sampling,
  thinking, context, and output settings.

Profiling measures the selected tag in place. It does not generate a
Modelfile, call Ollama `/api/create`, add an `ax/` prefix, or deploy a replacement
tag. An existing `ax/` tag remains usable as an ordinary exact artifact; its
prefix grants no qualification.

## Qualification rules

Quick profiles are diagnostic only. Standard and full profiles can set
`benchmarkQualified=true` after context evidence is recorded. Benchmark and
profile-gated inference fail closed unless all of these are true:

1. the exact tag is installed on the requested host;
2. its live digest equals that host's active registry installation digest;
3. readiness and performance/context evidence match the current digest and
   runtime fingerprint;
4. readiness is not stale and is benchmark-qualified; and
5. the benchmark campaign freezes that same identity and its explicit
   execution settings.

The legacy `stage` value remains as a derived display/compatibility summary; it
is not admission authority. Installation, profile currency, benchmark
qualification, capability evidence, and pin state remain independent.

Standard records performance and diagnostic context capacity. Automatic
interactive/document context recommendations require Full's repeated context
samples; a Standard performance qualification alone does not supply them.
Standard can support a comparison with an explicitly selected context matching
its throughput baseline and within its current measured capacity. Fresh capacity remains usable for that check
even when automatic recommendations are unknown. Neither a historical maximum
nor an unknown recommendation selects a runtime context.

There is no bare-to-namespaced fallback. `useAdapted=true` is rejected, and the
legacy profiler adaptation endpoint is retired.

## Reading the measurements

Throughput, context probes, and the prefill/decode matrix explicitly disable
thinking so they measure the same generation mode. The separate thinking probe
records that capability; it does not silently change performance measurements.

Full's throughput curve holds the allocated context fixed at the measured
maximum, then fills 10%, 25%, 50%, 75%, and 90% of it. Cold/hot load timings use
that same allocation and verify Ollama's reported context after both loads.
A cold sample also requires a verified unload. These timings include the
one-token request, not just Ollama's internal model-loading duration.

Context capacity requires exact GPU residency in bytes. A rounded display of
100% cannot prove that no bytes spilled onto the CPU. Capacity is a successful
synthetic workload measurement; it does not establish answer quality across a
long document. Compare useful tasks separately before selecting a larger
everyday context.

A single profile completes after the pinned models have been restored. Active
profiles and host queues stay visible even when a long run exceeds the completed
history retention period.

## Judging and comparisons

Keep the prompt set, execution settings, model identities, and judge target
consistent across candidates. Repeated runs measure variability on each prompt;
they do not create additional independent questions.

A missing calibration grade remains unscored, including when the reference
grade is zero. Reference grades must be finite values on the 0–10 scale.
Truncated judge output requires review even when its remaining confidence score
is high. An authored calibration set is useful for regression checks; it is not
independent human validation of a judge on every workload.

Scorer 2.5 rejects non-finite judge scores and fixes the low-quality composite
cap so it cannot raise a lower score. Stored historical scores are not rewritten;
compare rows from the same scorer version or label the difference explicitly.

## Clean-slab workflow

1. Pull the desired tags on each Ollama host.
2. Run Core registry sync (`POST /api/models/registry/sync-hosts`).
3. Baseline each host, then run a Standard or Full profile for each exact tag.
4. Review the recorded digest/runtime evidence.
5. Choose an explicit measured context for Standard, or use qualified Full
   recommendations. Start a benchmark; preflight verifies the same identity again and freezes it
   for the campaign.

Before upgrading an existing database, inspect the migration:

```bash
cd benchmark
npm run migrate:exact-artifacts -- --dry-run
```

Apply it after taking the normal database backup:

```bash
npm run migrate:exact-artifacts
```

The migration marks pre-identity context/readiness records stale and creates
the exact-evidence indexes. To remove the retired `modeladaptations` collection
as part of an intentional clean-slab reset, add
`--purge-legacy-adaptations`. The migration does not remove installed Ollama
tags or historical benchmark results.

Custom tags are still valid for real semantic derivatives that cannot be
expressed as request or HostPreference policy, such as a template, adapter, or
system prompt. They must be created outside the profiler, versioned, registered
under their exact tag/digest, and profiled as a new artifact.
