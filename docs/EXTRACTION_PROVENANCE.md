# Extraction provenance

- Extracted: 2026-08-12
- Authoritative source: local AIOps repository
- AIOps source branch: `codex/agentx-product-extraction`
- AIOps source commit: `0521e1a` (`feat: isolate Agent X product demo boundary`)
- Imported directories: `core/`, `benchmark/`, `rag/`, `shared/`
- Excluded before import: service-local AIOps agent instructions, environment
  examples, migration archives, Core dated review notes, and Benchmark Gift
  Edition packaging
- New repository remote: none

AIOps was the sole content source. The discarded legacy local `AgentX`
checkout was not read for content and was not copied. Its GitHub remote was not
changed or contacted during deletion.

This repository then received product-only runtime and documentation
adaptations: standalone Compose/Dockerfiles, secret-free onboarding, a neutral
RAG filesystem policy, and the canonical knowledge boundary.
