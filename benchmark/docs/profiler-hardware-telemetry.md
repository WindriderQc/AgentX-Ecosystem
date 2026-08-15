# Profiler runtime telemetry

The model profiler records bounded runtime telemetry beside each model profile.
It talks directly to the Ollama endpoint selected by the user; it does not
install or depend on an operating-system agent.

## Captured data

- Generation speed, prompt-evaluation speed, TTFT, latency, and token counts.
- Loaded-model VRAM reported by Ollama `/api/ps`.
- Total VRAM only when the user explicitly records it in the host profile.
- VRAM pressure derived when both loaded and configured totals are available.

The product does not collect PCIe, power, temperature, topology, filesystem,
or general host inventory. Environment-specific telemetry collectors and host
automation belong outside Agent X and may use bounded product APIs when a
concrete integration requires them.

## UI controls

The Models tab can display the runtime snapshot used during profiling. Missing
hardware metadata is shown as unavailable; the profiler does not propose an
agent installer or silently reach an operations control plane.
