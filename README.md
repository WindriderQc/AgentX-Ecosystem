# Agent X Ecosystem

Agent X is a local-first AI workbench that routes Ollama inference, grounds
answers in a bounded knowledge base, and compares models with reproducible
evidence.

## What belongs here

- **Core** — inference, model discovery and routing, prompts, telemetry,
  Dreaming, and product APIs;
- **Benchmark** — repeatable model evaluation, profiling, scoring, and
  comparison;
- **RAG** — document ingestion, embeddings, retrieval, and knowledge
  contracts;
- **Shared contracts** — runtime-profile and browser URL boundaries used by
  those services;
- **Portable skills** — optional, versioned agent instructions for open
  formats; skills do not load into services or grant access to private data;
- **Demo and onboarding** — a secret-free Windows/Linux first-run path.

The default `demo` profile does not load private data, environment-specific
operations, or external extensions. Core contains no private implementation,
and the product supplies no private endpoint, credential, or host mount. A
minimal trusted-extension loader exists only for explicit full-profile
deployments and is disabled by default.

## First run

Prerequisites are Git and a running Docker Desktop (Windows) or Docker Engine
with a recent Compose v2 plugin (Linux). `doctor` verifies the required
health-aware startup options. Ollama is not a prerequisite.

Clone the repository once, then run the command for your operating system:

```text
git clone https://github.com/WindriderQc/AgentX-Ecosystem.git
cd AgentX-Ecosystem
```

Windows:

```powershell
.\agentx.ps1 doctor
.\agentx.ps1 up
.\agentx.ps1 health
```

Linux:

```bash
chmod +x agentx
./agentx doctor
./agentx up
./agentx health
```

`up` starts the demo profile and waits up to 180 seconds for its five product
services. Open <http://localhost:3180/> when it succeeds. MongoDB and Qdrant
stay internal; the three public ports bind to loopback only, and persisted data
uses dedicated `agentx-ecosystem` named volumes.

If Docker is missing or stopped, `doctor` exits with an actionable message and
does not install anything. If Ollama is missing, startup and product health
still pass; the UI reports inference and embeddings as unavailable until the
tester explicitly chooses an endpoint and models.

No model is downloaded automatically. After the UI-only first run, detect a
native Ollama or choose the isolated opt-in Docker path:

```powershell
.\agentx.ps1 ollama-doctor
.\agentx.ps1 ollama-up
.\agentx.ps1 ollama-pull llama3.2:3b
```

The equivalent Linux commands use `./agentx`. Read
[First installation](docs/GETTING_STARTED.md) before choosing a local or
remote endpoint.

## Three guided demos

1. **Route a local answer:** open Chat and ask a short question. Agent X routes
   automatically across models you explicitly installed; use **Take the
   controls** only to pin an exact model. Then inspect **Models** or **Activity**
   to see the visible inference boundary.
2. **Compare a persona:** keep one model and question fixed, switch between the
   built-in `learning_guide` and `default_chat` personas, and compare how the
   reusable system prompt changes the answer without changing routing authority.
3. **Ground and compare:** ingest a small non-sensitive document through RAG,
   retrieve a fact unique to it, then open Benchmark to compare candidate
   models on reproducible evidence.

Detailed steps live in [Demo guide](docs/DEMO.md). The current architecture is
defined by [Architecture](docs/ARCHITECTURE.md) and the rendered Compose model.
The permanent simple-to-expert interaction and visual rules are defined by the
[UX doctrine](docs/UX_DOCTRINE.md).

## Stop, clean up, and troubleshoot

Use `status` to inspect containers and `logs core` (or another service name) to
follow an error. `down` stops both the product and opt-in Docker Ollama while
preserving named volumes. `reset` requires typing a confirmation phrase and
deletes only this Compose project's containers, network, and data volumes.

Port conflicts can be handled without editing Compose:

```powershell
$env:CORE_PORT=3280; $env:BENCHMARK_PORT=3281; $env:RAG_PORT=3282
.\agentx.ps1 up
```

```bash
export CORE_PORT=3280 BENCHMARK_PORT=3281 RAG_PORT=3282
./agentx up
```

The small secret-free input file is [`config/agentx.env`](config/agentx.env).
Keep secrets and machine-specific endpoints outside the repository. See
[First installation](docs/GETTING_STARTED.md) for error paths.

Profiling and benchmark admission follow the
[exact-artifact profiling contract](docs/EXACT_ARTIFACT_PROFILING.md): profiling
records host-bound evidence and never creates or silently selects another model
tag.

Benchmark also provides a stateless
[cloud/local lane accounting contract](docs/CLOUD_LOCAL_LANE_ACCOUNTING.md).
It keeps local, free-cloud, and paid-cloud evidence in separate exact-contract
cohorts, enforces local-only family/kid lanes, and attributes already-observed
paid calls with immutable integer-nanodollar receipts. Its HTTP routes never
contact a provider, authorize spend, or mutate routing. A separate fail-closed
operator CLI can run exact local/free campaigns with current identity and price
preflight, per-call receipts, and retained raw evidence; paid execution requires
a deployment-owned authenticated integration.

## Install and update

Normal users should follow the latest stable GitHub release. Controlled
deployments pin the Core, Benchmark, and RAG container digests. Advanced users
may opt into the moving `main`/`test` channel. Exact commands and rollback
expectations are in [Install and update modes](docs/RELEASES.md).

Agent X does not require an operations repository. Host-specific automation
and private integrations stay outside this repository and may call the bounded
product APIs. Independently deployed applications can use the generic,
stateless [external consumer API](docs/EXTERNAL_CONSUMERS.md) for authenticated
routed inference, effective capability discovery, streaming, and cancellation
without loading application code or storing application transcripts in Core.
Advanced operators may also install an absolute-path trusted
extension in the full profile; Core owns only the generic loader and versioned
contracts, never the extension source, secret, mount, or deployment. See
[Trusted extensions](docs/TRUSTED_EXTENSIONS.md).

Portable Agent Skills under [`skills/`](skills/) are optional source
artifacts. Installing one into Codex, Hermès Agent, OpenClaw, or another
compatible runtime is an explicit action controlled by that runtime. A skill
does not receive filesystem, vault, network, or RAG authority merely by being
present in this repository.

A separately operated private Data service may expose a bounded, read-only
API to agents. It is not an Agent X service, an Agent X skill, or an adapter
implementation owned by this repository.

Agent X is available under the [MIT License](LICENSE). Report security issues
through the private process described in [Security policy](SECURITY.md).
