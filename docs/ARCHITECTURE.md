# Agent X architecture

Status: canonical product architecture, verified 2026-08-15.

## Product topology

| Component | Responsibility | Depends on |
|---|---|---|
| Core (`core`, internal 3080) | Inference boundary, model discovery/routing, prompts, telemetry, Dreaming, product UI and APIs | MongoDB; optional Ollama; Benchmark and RAG service contracts |
| Benchmark (`benchmark`, internal 3081) | Runs evaluations, profiles models, scores evidence, renders comparisons | MongoDB; Core; optional Ollama |
| RAG (`rag`, internal 3082) | Ingests bounded documents, embeds chunks, retrieves knowledge, exposes the RAG API | MongoDB; Qdrant; Core embedding proxy |
| `shared/` | Small cross-service contracts with identical semantics | No runtime service |
| MongoDB | Product metadata and evaluation state | Internal only |
| Qdrant | Vector storage | Internal only |
| Ollama | User-selected inference runtime | Optional; native, isolated Docker, or explicit remote endpoint |

The default Compose project is `agentx-ecosystem`. Product ports 3180–3182 bind
to host loopback only; MongoDB, Qdrant, and opt-in Docker Ollama have no host
port. All persisted data uses named volumes owned by this project. There are no
host bind mounts.

## Runtime boundary

`AGENTX_PROFILE=demo` is the product-safe default, including when the variable
is absent. It exposes inference, model,
RAG, Benchmark, and evidence surfaces while rejecting private storage,
environment-specific integrations, household devices, and other operator
routes. It also skips full-profile monitors, backups, host polling, and model
prewarming. Empty integration variables are deliberate and must not fall back
to a private or production address.

Environment-specific automation and private adapters live outside this
repository. They may consume bounded product APIs, but Agent X neither embeds
their implementations nor loads external adapter modules. The repository does
not define an operations extension framework.

A private Data service may independently expose a bounded, read-only API to
agents. Data remains outside the product boundary: it is neither a product
service nor a skill owned or loaded by Agent X.

## Contract rules

- Cross-service calls use Docker DNS (`core`, `benchmark`, `rag`, `mongo`,
  `qdrant`); browser links use explicit localhost public URLs.
- The product starts and presents its UI without Ollama. Inference and
  embeddings report unavailable until the user selects an endpoint/model.
- Readiness requires MongoDB for all services and Qdrant for RAG. Ollama and
  embedding models are reported as optional capabilities, not startup gates.
- A remote Ollama endpoint is an explicit operator choice. The repository does
  not contain or default to a private or production network.
- Filesystem scanning is disabled by topology: the image has a bounded
  `/data/imports` policy but no host mount. Public demo ingestion uses HTTP.
- Product documentation is permanent and current. Evolution logs, migration
  plans, incident notes, inventories, and audits do not belong in this
  repository.
