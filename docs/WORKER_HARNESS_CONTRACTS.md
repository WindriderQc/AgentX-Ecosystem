# External worker and harness evidence contracts

Status: active product contract, version 1.

> AgentX is an agent-capability platform. It exposes routed inference,
> evaluation, RAG, task/tool contracts, and evidence. It does not own an
> external harness's identity, private conversations, internal memory, or
> execution loop.

This contract lets a separately operated harness receive a provider-neutral
work description and return bounded evidence. It is a capability and proof
boundary, not an execution protocol: AgentX does not start a harness, schedule
its turns, inject credentials, mount its workspace, proxy its tools, or choose
its fallback behavior.

The implementation is the shared module `shared/workerContract.js`. It follows
the existing product convention of explicit JavaScript normalization,
deterministic validation errors, canonical serialization, and SHA-256
fingerprints. Benchmark consumes the same normalized objects; there is no
second schema implementation and no new database or service.

## WorkerEnvelope v1

Contract identity is `agentx.worker-envelope/v1` with `schemaVersion: 1`.
The normalized object contains:

- `task.id` and `task.correlationId`, both opaque logical identifiers;
- `work.description` and/or a logical `work.reference`;
- a logical `workspace.id` and `kind`, never a host filesystem path;
- `dataClassification`: `public`, `internal`, `confidential`, or `restricted`;
- `executionProfile`: `portable` or `native-ceiling`;
- exact harness/model requests or bounded selection constraints;
- a prompt reference and required SHA-256 prompt fingerprint, never a
  requirement to publish prompt contents;
- an allowlist of tools with version and schema fingerprint, plus the
  normalized aggregate tool-schema fingerprint;
- integer ceilings for duration, tokens, nanodollar cost, turns, and tool
  calls;
- explicit filesystem, network, and output policies with their aggregate
  fingerprint; and
- the expected result format, optional result-schema fingerprint, and required
  evidence kinds.

Filesystem policy is `none`, `read_only`, or `workspace_write`. Network policy
is `none` or an allowlist of logical destination identifiers. Structural
validation rejects URLs, sockets, and filesystem paths. Names and IDs are
publication-safe logical identifiers: adapters must never place credentials,
hostnames, physical paths, or other deployment topology in them. The consuming
deployment resolves those logical capabilities under its own private policy.

The complete neutral example is
[`benchmark/data/worker-envelope.example.json`](../benchmark/data/worker-envelope.example.json).

## WorkerReceipt v1

Contract identity is `agentx.worker-receipt/v1` with `schemaVersion: 1`.
Every receipt retains the exact execution tuple:

`harness + version + adapter + version + provider + version + model + version
+ digest/runtime fingerprint + API + version + prompt + tools + policies +
environment`.

The receipt includes:

- the exact versioned harness, adapter, provider, model, API, and logical
  execution-environment identity;
- model digest and/or runtime fingerprint when the executor can observe them;
- envelope, prompt, tool-schema, and policy fingerprints;
- a derived `executionTupleFingerprint`;
- final state and, for every non-success, a required failure classification;
- measured duration, token use, nanodollar cost, turns, and tool calls;
- counted tool error codes and human-intervention kinds, without messages,
  actor identities, or conversation content;
- logical, optionally digest-bound patch/artifact/test references;
- counted scope/policy violation codes;
- result-contract satisfaction and an optional result fingerprint; and
- the deterministic receipt fingerprint.

Success cannot carry failure metadata. Non-success cannot omit its failure
classification. Token totals must equal input plus output. When validation is
given the source envelope, profile and envelope/prompt/tool/policy fingerprints
must match exactly. A succeeded receipt must satisfy its result contract and
stay within every envelope budget; a non-success receipt cannot claim that the
result contract was satisfied. Exact requested harness/model/provider/version/
digest fields must match the receipt identity, and every required evidence kind
must be present on success.

The complete neutral example is
[`benchmark/data/worker-receipt.example.json`](../benchmark/data/worker-receipt.example.json).

## Deterministic normalization and fingerprints

Normalization trims bounded text, lowercases enumerations, sorts set-like
arrays, rejects duplicate identities, applies integer bounds, and removes
fields outside the v1 allowlist. Fingerprints are lowercase SHA-256 over the
existing recursively key-sorted canonical serialization used by AgentX exact
artifact contracts.

Callers may provide an envelope or receipt fingerprint. Validation recomputes
it and fails with a stable mismatch code if any normalized material field has
changed. Derived fingerprints are never accepted as authority for credentials,
network access, routing, or candidate promotion.

These hashes provide deterministic integrity and comparison identity, not
authenticity. A deployment that needs producer authentication or
non-repudiation must add transport authentication or signatures outside this
neutral contract.

## Benchmark comparison profiles

Benchmark adds the pure calculation endpoint:

`POST /api/benchmark/worker-evidence/compare`

The body contains `profile`, at least two `evidence` entries, and optionally
`generatedAt`. Every evidence entry contains its source `envelope` and one
`receipt`. The endpoint normalizes the envelope and validates the receipt
against it before comparison. It stores nothing, makes no provider/harness
call, and returns a fingerprinted `agentx.worker-evidence-comparison/v1`
report.

### Portable

`portable` isolates harness behavior. All receipts must bind the same exact
model/provider/API, envelope, prompt, tools, and policies, and the comparison
must include at least two distinct exact harness identities. Adapter and logical
environment identities may differ. Any frozen-input drift rejects the
comparison with `PORTABLE_CONTRACT_MISMATCH`.

### Native ceiling

`native-ceiling` preserves each exact model+harness pair and its native prompt,
tool, policy, API, adapter, and environment tuple. Benchmark reports separate
tuple and native-pair fingerprints instead of pretending the inputs are a
portable controlled cohort.

Both profiles compare success, latency, tokens, cost, turns, tool calls,
errors, interventions, violations, and evidence counts side by side. Neither
profile emits a universal winner, ranks unlike tuples, changes routing, or
promotes a candidate. Existing model campaigns and the cloud/local lane
contract remain unchanged.

## Privacy and ownership

The public receipt projection is an explicit allowlist. It never includes the
work description, prompt text, response, transcript, tool arguments/results,
error messages, credentials, URLs, or filesystem paths. The private receipt
retains the logical environment identity, version, and fingerprint; the public
projection emits only its fingerprint. Unknown input fields are discarded
before projection and fingerprinting. Logical evidence references are not
dereferenced by AgentX.

The external harness owns its users, identity boundary, private conversation,
memory, orchestration loop, tool execution, workspace realization, provider
credentials, retention, retries, and release lifecycle. A deployment-owned
adapter or runner may translate this contract and submit receipts to Benchmark;
that code belongs outside this repository, normally in AIOps when it is
environment-specific.
