# Profiler Hardware Telemetry

The model profiler records optional hardware telemetry beside each model profile.
This helps explain low `tok/s` or high TTFT without making the user leave the
profiler page.

## What Is Captured

- Generation speed: `tok/s`, prompt eval `tok/s`, TTFT, latency, prompt tokens,
  completion tokens.
- Runtime memory: Ollama loaded-model VRAM from `/api/ps`.
- Host-agent GPU telemetry when Core has it: per-GPU utilization, VRAM used and
  total, power draw, temperature, PCIe generation and width (current AND
  hardware max), and topology text when the agent reports it.
- Diagnostics derived from the snapshot: VRAM pressure, multi-GPU imbalance,
  low PCIe link warnings, and thermal warnings.

## Data Sources

The benchmark service does not run `nvidia-smi` directly on benchmark hosts.
Instead, it reads normalized telemetry through Core/host-agent endpoints, then
falls back to Ollama `/api/ps` when host-agent data is unavailable.

This keeps profiling safe for remote hosts, containers, and Windows/Linux mixed
deployments. A host-agent can still collect information equivalent to:

```text
nvidia-smi topo -m
nvidia-smi --query-gpu=name,pcie.link.gen.current,pcie.link.gen.max,pcie.link.width.current,pcie.link.width.max,utilization.gpu,memory.used,power.draw,temperature.gpu --format=csv
ollama ps
```

## UI Controls

The Models tab advanced settings include:

- Hardware Telemetry: capture GPU/VRAM/PCIe snapshots during profiling.
- Diagnostics Display: show compact hardware strips on model profile cards.

If host-agent telemetry is missing, the profiler still stores speed, TTFT, safe
context, spill behavior, and Ollama VRAM data. PCIe, physical per-GPU VRAM,
power, temperature, and topology require host-agent/Core telemetry.

## Interpreting Warnings

- High VRAM pressure means the model is close to the card limit and may spill at
  larger context or when another model is loaded.
- PCIe warnings flag a current link **below the hardware's max** for that GPU
  (e.g. linked at Gen3 on a Gen4-capable card, or x8 on a card that can do x16).
  Hardware ceilings — the platform's actual max — are not warnings. Common
  causes for a real downgrade: idle power-state downclock (resolves under load),
  cheap PCIe risers, BIOS forced to a lower gen, or a partially-seated card.
  Down-linked PCIe can hurt multi-GPU or spill-heavy runs more than a single
  fully-offloaded GPU run. If the host-agent doesn't report a max value, the
  profiler stays silent rather than guess against an unknown ceiling.
- Multi-GPU imbalance means one GPU is much busier than another. That can
  indicate uneven tensor split, host contention, or a model that is not really
  using all cards efficiently.
