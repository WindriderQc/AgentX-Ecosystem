# First installation: Windows and Linux

Agent X starts its UI and data services without installing Ollama or
downloading a model. Inference and embeddings become available only after you
choose a native, Docker, or remote Ollama endpoint. No default points to an
AIOps production host.

## Windows

Detect a native installation and its health:

```powershell
Get-Command ollama -ErrorAction SilentlyContinue
Invoke-RestMethod http://127.0.0.1:11434/api/version
.\agentx.ps1 ollama-doctor
```

If the CLI exists but health fails, start the Ollama app from the Start menu or
run `ollama serve` in another terminal. If it is absent, review the official
[Windows guide](https://docs.ollama.com/windows) and choose the installer
yourself. Agent X never runs an installer or changes Windows services.

Start Agent X with native Ollama:

```powershell
$env:AGENTX_OLLAMA_HOST='http://host.docker.internal:11434'
.\agentx.ps1 up
```

Choose models only when ready:

```powershell
ollama pull llama3.2:3b
# Optional for the guided RAG workflow:
ollama pull nomic-embed-text:v1.5
```

## Linux

Detect a native installation and its health:

```bash
command -v ollama
curl --fail --silent http://127.0.0.1:11434/api/version
./agentx ollama-doctor
```

If installed as a system service:

```bash
sudo systemctl start ollama
sudo systemctl status ollama
```

A CLI-only installation can run `ollama serve` in another terminal. If Ollama
is absent, review the official [Linux guide](https://docs.ollama.com/linux)
before running any installer or privileged command. Agent X never installs or
enables it automatically.

Start Agent X with native Ollama:

```bash
export AGENTX_OLLAMA_HOST='http://host.docker.internal:11434'
./agentx up
```

Choose models only when ready:

```bash
ollama pull llama3.2:3b
# Optional for the guided RAG workflow:
ollama pull nomic-embed-text:v1.5
```

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

Related pins are `AGENTX_DEFAULT_CHAT_MODEL`,
`AGENTX_GENERAL_CHAT_MODEL`, `AGENTX_ROUTER_EMBEDDING_MODEL`, and
`EMBEDDING_MODEL`. `OLLAMA_HOST_NAME` is only a display label. Keep secondary
hosts empty for first installation.
