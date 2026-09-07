# Agent X Ecosystem

Agent X is a local AI workspace for chatting with your models, searching your
documents, and comparing model performance. It runs on Windows and Linux with
Docker. You choose the inference endpoint and models; no model is downloaded
automatically.

| What you want to do | Where to start |
| --- | --- |
| Ask a question, switch prompts, or control model routing | **Chat**, **Prompts**, and **Models** |
| Add documents and find passages with source context | **Knowledge** |
| Run evaluations, profile models, and compare results | **Compare models** |
| Inspect activity, performance, or compare a council of models | **Activity**, **Performance**, and **Council** |
| Manage work, schedules, memory proposals, and backups | Full-profile workspaces |

The default **demo** profile provides the chat, knowledge, and evaluation
experience. Advanced controls stay available through **Take the controls**.
The **full** profile additionally enables the product's operational workspaces.
Neither profile installs private adapters or loads personal data.

## First run

Install Git and start Docker Desktop on Windows, or Docker Engine with Compose
v2 on Linux. Then clone the repository:

~~~text
git clone https://github.com/WindriderQc/AgentX-Ecosystem.git
cd AgentX-Ecosystem
~~~

**Windows**

~~~powershell
.\agentx.ps1 doctor
.\agentx.ps1 up
.\agentx.ps1 health
~~~

**Linux**

~~~bash
chmod +x agentx
./agentx doctor
./agentx up
./agentx health
~~~

Open [Agent X](http://127.0.0.1:3180/) after startup succeeds. Startup waits up
to 180 seconds for the three application services and their MongoDB/Qdrant
dependencies. Application ports bind to loopback; databases stay internal.
The product has no built-in authentication and is intended for a trusted local
network. See [Security](SECURITY.md) for its deployment assumptions.

**Ollama is optional for startup.** Without it, you can explore the UI;
inference and embeddings become available once you configure suitable models.
Check a native installation, or explicitly start the isolated Docker option:

~~~powershell
.\agentx.ps1 ollama-doctor
.\agentx.ps1 ollama-up
.\agentx.ps1 ollama-pull llama3.2:3b
# Add an embedding model when you want to use Knowledge:
.\agentx.ps1 ollama-pull nomic-embed-text:v1.5
~~~

Linux uses the same commands with ./agentx. See
[First installation](docs/GETTING_STARTED.md) for native/remote endpoints,
configuration, port conflicts, and troubleshooting.

## Try it

1. **Chat:** ask a short question using a model you installed. Inspect the
   selected model and route, or open **Take the controls** to make a choice.
2. **Prompts:** keep the model and question fixed, then compare Learning Guide
   and Default Chat to see how the system prompt changes the answer.
3. **Knowledge:** paste a short document, find a fact unique to it, and open the
   exact source passage. Then use Benchmark to compare candidate models.

The [Demo guide](docs/DEMO.md) walks through these examples and their expected
results. Knowledge requires the configured embedding model as well as its
MongoDB and Qdrant dependencies.

To enable the full profile:

~~~powershell
$env:AGENTX_PROFILE = 'full'
.\agentx.ps1 up
~~~

~~~bash
AGENTX_PROFILE=full ./agentx up
~~~

This exposes System status, Work in progress, Planning, Cluster Schedule,
Memory Review, and Backup. External extensions remain separately configured
and disabled by default.

## Everyday commands

Use .\agentx.ps1 on Windows or ./agentx on Linux, followed by a command:

| Command | Purpose |
| --- | --- |
| status | Inspect containers |
| health | Check service readiness |
| logs core | Follow a service's logs; also accepts benchmark or rag |
| down | Stop the product and optional Docker Ollama, keeping stored data |
| reset | Delete this Compose project's data and recovery archives after exact typed confirmation |

Configuration defaults live in [config/agentx.env](config/agentx.env); shell
variables can override them. Keep machine-specific endpoints and secrets out
of committed files. Follow [Install and update](docs/RELEASES.md) for stable
releases, exact image versions, and rollback.

Backups use a separate persistent volume. Export them for protection against
host loss. Database restore is disabled by default; see
[Recovery](docs/RECOVERY.md) for the available operations and limitations.

## Understand the code

| Directory | Responsibility |
| --- | --- |
| core/ | Inference, routing, prompts, conversations, Dreaming, UI, and product APIs |
| benchmark/ | Model evaluation, profiling, scoring, and comparison |
| rag/ | Document ingestion, embeddings, retrieval, and knowledge UI |
| shared/ | Common behavior used by multiple services |
| docker/, config/ | Product images and runtime configuration |
| skills/ | Optional portable agent instructions; services do not execute them automatically |

Start with [Architecture](docs/ARCHITECTURE.md) for service responsibilities
and interactions, [UX guidance](docs/UX_DOCTRINE.md) for interface conventions,
and the [product plan](docs/PRODUCT_EVOLUTION_PLAN.md) for remaining work.
The [page inventory](config/product-surfaces.json) lists supported surfaces.
Each service's package.json contains its development and test commands;
Core also needs npm run build for shared browser assets. CI runs the three
service suites and renders Compose. See [Running Product tests](docs/TESTING.md)
for dependency preparation and isolated test runs.

## Feature and integration guides

| Topic | Guide |
| --- | --- |
| RAG endpoints | [Knowledge API](rag/API.md) |
| Profiling and model identity | [Exact-artifact profiling](docs/EXACT_ARTIFACT_PROFILING.md) |
| Guided evaluation campaigns | [Benchmark sweeps](benchmark/docs/sweeps-pipeline.md) |
| Comparing cloud and local observations | [Lane accounting](docs/CLOUD_LOCAL_LANE_ACCOUNTING.md) |
| Connect an independent application | [External consumer API](docs/EXTERNAL_CONSUMERS.md) and [consumer responsibilities](docs/EXTERNAL_ADAPTER_CONTRACT.md) |
| Connect a voice-oriented consumer | [Nestor consumer API](docs/NESTOR_CONSUMER.md) |
| Exchange external worker results | [Worker envelopes and receipts](docs/WORKER_HARNESS_CONTRACTS.md) |
| Enable optional external benchmark execution | [Harness broker](docs/BENCHMARK_HARNESS_BROKER.md) |
| Load a separately deployed extension | [Trusted extensions](docs/TRUSTED_EXTENSIONS.md) |

Agent X is usable on its own. External assistants and harnesses own their
identity, private conversations, memory, credentials, and execution loops.
Private Data services, operations, and environment-specific adapters live
outside this repository. Portable [skills](skills/) grant no data or tool
access by themselves.

Available under the [MIT License](LICENSE).
