# Agent X Ecosystem

Agent X is a local-first AI workbench that routes Ollama inference, grounds
answers in a bounded knowledge base, and compares models with reproducible
evidence.

## What belongs here

- **Core** — inference, model discovery and routing, prompts, telemetry, and
  product APIs;
- **Benchmark** — repeatable model evaluation, profiling, scoring, and
  comparison;
- **RAG** — document ingestion, embeddings, retrieval, and knowledge
  contracts;
- **Shared contracts** — runtime-profile and browser URL boundaries used by
  those services;
- **Demo and onboarding** — a secret-free Windows/Linux first-run path.

The default `demo` profile does not load private data, environment-specific
operations, or external adapters. Some transitional adapter modules remain in
Core, but the product profile blocks their routes and supplies no endpoint,
credential, or host mount.

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

## Two guided demos

1. **Route a local answer:** open Playground, select a model you explicitly
   installed, ask a short question, then inspect Models or Analytics to show
   the visible inference boundary.
2. **Ground and compare:** ingest a small non-sensitive document through RAG,
   retrieve a fact unique to it, then open Benchmark to compare candidate
   models on reproducible evidence.

Detailed steps live in [Demo guide](docs/DEMO.md). The current architecture is
defined by [Architecture](docs/ARCHITECTURE.md) and the rendered Compose model.

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
[First installation](docs/GETTING_STARTED.md) for error paths and
[Extensions](docs/EXTENSIONS.md) for the intentionally narrow, disabled-by-default
extension seam.

## Install and update

Normal users should follow the latest stable GitHub release. Controlled
deployments pin the Core, Benchmark, and RAG container digests. Advanced users
may opt into the moving `main`/`test` channel. Exact commands and rollback
expectations are in [Install and update modes](docs/RELEASES.md).

Agent X does not require an operations repository. An advanced user may keep
host-specific configuration and integrations in a separate private workspace
and load trusted adapters through the small, full-profile-only
[extension seam](docs/EXTENSIONS.md). The default demo never loads them.

Agent X is available under the [MIT License](LICENSE). Report security issues
through the private process described in [Security policy](SECURITY.md).
