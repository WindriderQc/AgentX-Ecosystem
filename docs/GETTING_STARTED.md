# First installation: Windows and Linux

Agent X needs Git, Docker, and Docker Compose v2. It starts its UI and data
services without Ollama or a model. Nothing in this workflow installs software,
downloads a model, or contacts a private endpoint automatically.

## Windows

Start Docker Desktop, then run from the cloned repository:

```powershell
.\agentx.ps1 doctor
.\agentx.ps1 up
.\agentx.ps1 health
```

Open <http://127.0.0.1:3180/>. Core, Benchmark, and RAG bind only to host
loopback by default. To check an optional native Ollama later:

```powershell
.\agentx.ps1 ollama-doctor
```

If it is installed but stopped, start the Ollama app or run `ollama serve` in
another terminal. If it is absent, Agent X remains usable for UI inspection.
The official [Windows guide](https://docs.ollama.com/windows) is the source for
an optional installation.

Choose models explicitly only when ready:

```powershell
ollama pull llama3.2:3b
# Optional for the guided RAG workflow:
ollama pull nomic-embed-text:v1.5
```

## Linux

Start Docker Engine, then run from the cloned repository:

```bash
chmod +x agentx
./agentx doctor
./agentx up
./agentx health
```

Open <http://127.0.0.1:3180/>. Core, Benchmark, and RAG bind only to host
loopback by default. To check an optional native Ollama later:

```bash
./agentx ollama-doctor
```

If installed as a service, start it using the method appropriate to the Linux
distribution. A CLI-only installation can run `ollama serve` in another
terminal. If Ollama is absent, Agent X remains usable for UI inspection. The
official [Linux guide](https://docs.ollama.com/linux) is the source for an
optional installation.

Choose models only when ready:

```bash
ollama pull llama3.2:3b
# Optional for the guided RAG workflow:
ollama pull nomic-embed-text:v1.5
```

### Automated clean-machine proof

Every Product pull request and `main` build repeats the documented Linux path
on a disposable hosted runner: `doctor`, `up`, then `health`. The gate verifies
the three service health identities, MongoDB and Qdrant readiness, the `demo`
profile, the public Learning Guide doorway, and the absence of private-runtime
identity on the landing page. It also proves that the launcher supplies one
ephemeral Benchmark credential and that no Ollama container, model download,
or trusted extension appears during the default start.

The runner removes the exact Compose containers, network, and named volumes at
the end, including after a failed check. This acceptance gate complements the
unit, Compose-render, and independent image-build jobs; it does not publish an
image or change the stable release channel.

## Optional isolated Docker Ollama — Windows or Linux

This path is CPU-first, has no host port, secret, personal mount, or automatic
model download, and stores models only in `agentx_ecosystem_ollama_data`.

Windows:

```powershell
.\agentx.ps1 ollama-up
.\agentx.ps1 ollama-status
.\agentx.ps1 ollama-pull llama3.2:3b
.\agentx.ps1 ollama-down
```

Linux:

```bash
./agentx ollama-up
./agentx ollama-status
./agentx ollama-pull llama3.2:3b
./agentx ollama-down
```

GPU pass-through is intentionally absent. It depends on the operating system,
hardware, drivers, and container runtime; use the official
[Ollama Docker guide](https://docs.ollama.com/docker) for a separate,
user-owned override.

## Endpoint and model variables

| Mode | `AGENTX_OLLAMA_HOST` | Notes |
|---|---|---|
| Native on the same host | `http://host.docker.internal:11434` | Default product path; models live outside Agent X containers |
| Opt-in Docker Ollama | set to `http://ollama:11434` by the overlay | Isolated named volume; no host API port |
| User-selected remote | `http://<approved-host>:11434` | Explicit choice; secure and authorize the network separately |

`EMBEDDING_MODEL` selects the RAG embedding model and `OLLAMA_HOST_NAME` is only
a display label. Agent X routes chat automatically across available models;
an exact model can be selected through **Take the controls**. Keep secondary
hosts empty for first installation.

`AGENTX_BENCHMARK_TOKEN` is an optional, user-supplied service credential. The
`agentx` and `agentx.ps1` launchers generate an ephemeral 256-bit value in memory
when one is not supplied. The default Compose file wires that one value to Core
and Benchmark but never contains a secret. Direct `docker compose` users may set
the variable explicitly; if it is absent or invalid, Benchmark requests remain
functional through Core's automated lane and general rate bucket. Never commit
the value.

The launchers likewise generate an ephemeral `AGENTX_RECOVERY_TOKEN`, reusing
the value from an existing Core or RAG container when possible. Compose passes
it only to Core and RAG. It authorizes the internal snapshot contract and must
never be committed or exposed to browser code.

A separately deployed generic or Nestor consumer may receive the shared,
route-scoped `AGENTX_EXTERNAL_CONSUMER_TOKEN`. Compose passes a value supplied
through the process environment only to Core; it remains empty by default and
does not belong in `config/agentx.env`. The credential authorizes only the two
versioned `/api/consumers/` contract families and must not be distributed as an
operator credential.

Full-profile deployments may also supply four purpose-scoped worker
credentials to Core. They are optional for the loopback-only website, but a
remote machine call fails closed unless its own value is configured and sent
in the matching header:

| Environment variable | Request header | Bounded route family |
| --- | --- | --- |
| `AGENTX_MEMORY_REVIEW_TOKEN` | `X-AgentX-Memory-Review-Token` | Memory Review producer run/observation/finalize/synthesis-input/candidate/failure flow |
| `AGENTX_SCHEDULE_TOKEN` | `X-AgentX-Schedule-Token` | Cluster schedule sync, claim, and claim release |
| `AGENTX_PIPELINE_TOKEN` | `X-AgentX-Pipeline-Token` | Pipeline worker next-task discovery, claim, non-final status, feedback, heartbeat, and the legacy `/api/todos` creation alias |
| `AGENTX_ALERT_DELIVERY_TOKEN` | `X-AgentX-Alert-Delivery-Token` | Alert delivery receipts only |

These credentials are not interchangeable and do not grant general API or
browser access. A pipeline worker credential cannot confirm `status=done`;
that final transition remains a trusted reviewer/operator action. Supply
values through the process environment or a separate deployment secret store,
never in `config/agentx.env` or a committed Compose override.

## Common error paths

- `doctor` says Docker is missing: install Docker separately, reopen the
  terminal, and retry.
- `doctor` says the engine is unreachable: start Docker Desktop or Docker
  Engine. No Agent X container was changed.
- `up` times out: run `status`, then `logs core`; MongoDB and Core must become
  healthy before Benchmark and RAG start.
- A host port is already in use: set `CORE_PORT`, `BENCHMARK_PORT`, and
  `RAG_PORT` in the shell before `up`.
- The UI loads but inference fails: this is expected without a reachable
  Ollama and an explicitly pulled chat model.
- RAG ingestion fails while the UI is healthy: pull the configured embedding
  model, then retry with a small non-sensitive document.

## Stop and cleanup

`down` stops product containers and the opt-in Docker Ollama container, if
present, but preserves data and the dedicated recovery volume. `reset` deletes
this Compose project's named volumes, including recovery archives, only after
typing `delete agentx-ecosystem data and recovery archives` exactly. Use
`ollama-down` when you started the Docker Ollama path and want the same
full-stack stop explicitly.
