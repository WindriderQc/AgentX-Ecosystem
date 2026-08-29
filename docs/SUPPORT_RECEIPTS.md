# Privacy-safe support receipts

Agent X can export a small machine-readable support receipt without collecting
logs, configuration, conversations, or deployment topology. The exporter reads
only product-owned evidence:

- the canonical `/health` response from Core, Benchmark, and RAG;
- the full-profile read-only ecosystem snapshot;
- the checked-in product surface registry.

Run it against the active product profile:

```bash
node scripts/export-support-receipt.js --profile demo --output support-receipt.json
node scripts/export-support-receipt.js --profile full --output support-receipt.json
```

The default service addresses match the product defaults. When ports differ,
pass `--core-url`, `--benchmark-url`, and `--rag-url`. Those input addresses are
used only for collection and never appear in the receipt.

The receipt contains allowlisted projections of:

- service name, product version, profile, build revision, observation time,
  and freshness;
- required component readiness, with Ollama explicitly non-required;
- ecosystem operational status, identity consistency, freshness and coverage
  counts, contradiction categories, and trust-check outcomes;
- product surface registry schema version, counts, and sorted stable surface
  identifiers.

It never copies raw responses or errors. URLs, URIs, filesystem paths, request
headers, environment variables, stack traces, secrets, task or chat content,
host identifiers, and private adapter data have no output field. Dynamic source
identifiers are collapsed to fixed categories such as `host` or
`unclassified`. API responses and the final JSON receipt both have fixed size
bounds.

The command exits non-zero when required health, identity, freshness, trust, or
registry evidence is missing or invalid. With `--output`, it still writes the
failed receipt first so its fixed reason codes can diagnose the failed gate.
The ecosystem gate is `skip` in the demo profile because that operator surface
is intentionally disabled there; it is required and fail-closed in the full
profile.

Run the focused contract tests with:

```bash
node --test scripts/export-support-receipt.test.js
```
