# Native-tool qualification

Status: Product contract. Live campaigns and deployment remain operator gates.

Agent X treats native tool calling as measured evidence for one exact model
artifact on one exact runtime. A model name, registry flag, or historical
`ModelProfile.capabilities.tools` boolean is not qualification evidence.

Benchmark owns `ToolCapabilityQualification`. Each campaign is bound to the
normalized model name, host URL and host ID, artifact digest, runtime
fingerprint, protocol version, fixture version, fixture fingerprint, frozen
Core inference-contract fingerprint, and exact Benchmark claim generation.
The campaign record is append-only while running and immutable after
finalization. Its evidence digest binds the schema, exact identity, frozen
contract, claim, repetitions, outcome, and validity window; Benchmark
recomputes that digest before exposing a qualifying result. Core reads the
bounded projection through Benchmark's evidence API; it never queries the
Benchmark collection directly.

## Consumer states

| Evidence | Core result |
|---|---|
| Completed repeated exact evidence; every mocked-tool scenario passes | `supported`, qualified |
| Completed repeated exact evidence; the runtime explicitly reports no native tool surface on every scenario | `unsupported`, qualified |
| Missing or legacy boolean only | `unknown`, not qualified |
| Interrupted, partial, or contract-violating run | `unknown`, not qualified |
| Host, host ID, digest, runtime, protocol, fixture, or expiry drift | `stale`, not qualified |

`unsupported` is therefore a measured conclusion, never a synonym for a
failure, timeout, interruption, malformed call, or absent record.

## Controlled campaign runner

The default CLI path is a deterministic golden dry-run with no network. Live
mode is a separate disruptive operation and requires all of the following:

1. the exact `RUN_NATIVE_TOOL_QUALIFICATION` confirmation token;
2. one explicit model, one explicit host, and 3-20 repetitions;
3. Mongo persistence availability before the host claim;
4. an exact Core Benchmark claim and continuously accepted heartbeats;
5. one frozen, qualified Core inference contract and unchanged artifact digest;
6. every canonical fixture scenario exactly once per repetition—live scenario
   filters are refused—and incremental evidence using only the versioned mocked
   toolbox;
7. exact claim release in `finally`, followed by default-pin and residency
   restoration verification.

Production tools, user data, provider credentials, roster sweeps, model pulls,
model pruning, routing changes, pin changes, and deployment are outside this
runner. A live campaign may be scheduled only after the Product release is
reviewed and the separately operated deployment grants its own maintenance
window.
