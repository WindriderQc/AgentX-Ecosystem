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

OpenClaw, Hermès Agent, OctoPrint, personal data, household tools, fleet
operations, and the AIOps task pipeline are not product dependencies. Some
integration adapter modules still live inside the imported Core code while the
boundary is being tightened; the default product profile blocks them.

## Start the product profile

Prerequisite: Docker Desktop on Windows or Docker Engine with Compose on
Linux. Ollama and models are optional.

Windows:

```powershell
.\agentx.ps1 up
```

Linux:

```bash
chmod +x agentx
./agentx up
```

Open <http://localhost:3180/>. Core, Benchmark, RAG, MongoDB, and Qdrant use
dedicated `agentx-ecosystem` containers and volumes. MongoDB and Qdrant are not
published to the host. Stop the stack with `down`; data remains in the named
volumes.

No model is downloaded automatically. Run `ollama-doctor` to detect a native
Ollama, or choose the isolated opt-in Docker path:

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
defined by [Architecture](docs/ARCHITECTURE.md) and the rendered Compose model,
not by dated plans or AIOps operational history.

## Relationship with AIOps

This repository is the presentable Agent X product. AIOps remains the separate
operator control plane for deployments, infrastructure, migrations, audits,
personal integrations, and ecosystem memory. AIOps may orchestrate this
checkout locally through explicit contracts, but neither repository should
infer the other's runtime from historical documents.
