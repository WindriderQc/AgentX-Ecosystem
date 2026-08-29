# Adapter-consumer conformance

Agent X ships an address-free conformance registry and verifier for the
product APIs that separately deployed consumers may read. The verifier checks
contracts; it does not install, load, or describe an adapter.

The checked-in registry covers:

- canonical Core and RAG health identity;
- the Portal health aggregation and ecosystem snapshot v2;
- generic external-consumer discovery and opaque routing;
- the separate Nestor discovery, opaque fixed-operation routing, and bounded
  read-only memory contract;
- bounded RAG status, document-list, and search reads.

Generic and Nestor responses use different versioned allowlists. Adding a
field to one does not silently authorize it in the other. Consumer projections
also fail conformance if they contain a `hostUrl`, another location-bearing
field, or an absolute URL. Health and read observations must be canonical
ISO-8601 timestamps within the registry's age policy. The verifier accepts an
honest degraded response only when its identity, timestamp, reason, dependency,
or warning evidence agrees with that state.

## Run it

Pass service locations at runtime:

```powershell
node scripts/verify-adapter-consumer-contracts.js `
  --core-url $env:AGENTX_CORE_URL `
  --rag-url $env:AGENTX_RAG_URL
```

For a non-loopback generic-consumer probe, the verifier reads the scoped token
from `AGENTX_EXTERNAL_CONSUMER_TOKEN`. Use `--consumer-token-env NAME` to select
a different deployment-owned environment variable. URLs and credentials never
belong in `config/adapter-consumer-contracts.json`.

Run the fixture suite without any services or network access:

```powershell
node --test scripts/verify-adapter-consumer-contracts.test.js
```

The suite exercises both healthy and honestly degraded receipts, plus negative
fixtures for stale/future evidence, identity and contract drift, topology
leaks, contradictory degraded states, unbounded result sets, and missing result
provenance.

## Separately operated Data services

A private Data service remains outside the Agent X product boundary. If an
operator wants to apply the same `service-health` or `bounded-read` validators,
they can supply a separate registry with `--registry` and a runtime location
with `--base-url data=...`. Such a service must set `productOwned` to `false`,
use its own non-Agent-X identity and version, and define explicit limits and
provenance alternatives. Its address, implementation, secrets, mounts, and
deployment policy must not be committed here.
