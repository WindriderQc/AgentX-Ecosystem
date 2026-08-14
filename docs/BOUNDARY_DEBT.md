# Product boundary debt

Status: current engineering boundary, reviewed 2026-08-12.

The first extraction deliberately preserves working product behavior before
attempting a large internal rewrite. The default profile is safe and
presentable, but these implementation boundaries still deserve focused work.

## Optional adapters still inside Core

OpenClaw, Hermès Agent, OctoPrint/Printer Vision, Leantime pipeline, personal
assistant, host/fleet, backup, storage, voice, and panel modules remain in the
imported Core tree. They are unreachable in the default profile and receive no
endpoint, credential, or host mount from product Compose.

The minimal adapter contract now exists in `core/src/extensions/extensionLoader.js`.
The printer-vision capability is the first seam proof: a full-profile operations
extension can claim it before the transitional built-in route is registered.
Remove one built-in family at a time only after route, data, image, mount, and
rollback conformance pass. OpenClaw and Hermès remain coupled more deeply and
must not be moved by blind file copying. Do not infer that file presence means
active product scope.

## Shared contract candidates

- `ModelContextProfile`, HTTP-agent configuration, and ObjectId validation
  have exact Core/Benchmark pairs. Promote the schema/test vectors into
  `shared/contracts` while leaving thin service adapters local.
- Benchmark preflight and Core admission/readiness use related evidence but
  make different lifecycle decisions. Share a small state vocabulary and
  evidence envelope, not the orchestration implementations.
- Model-name normalizers have similar shapes with different semantics. Add
  cross-service fixtures first and extract only rules proven identical.
- Service-local loggers and browser clients are intentional adapters; their
  repetition alone does not justify a common service.

The generic peer threshold “no more than three identical blocks” is not an
acceptance rule. Risk, contract stability, and demonstrated semantic identity
decide whether code is shared.

Benchmark's `mc-*` CSS/DOM namespace means **model card**. It predates this
extraction, has no relationship to a control-plane service, and is preserved
because renaming coordinated UI selectors would be cosmetic and risky.

## Validation limits at extraction

- The AIOps source baseline passed RAG 415/415 in serial and Core 2,188/2,189,
  with the single concurrent Mongo timeout passing 13/13 on focused rerun.
- The imported product baseline passes the Core profile contract and build,
  79 focused Benchmark assertions, and 73 focused RAG assertions.
- The standalone full RAG command exceeded the 120-second extraction gate and
  was classified non-conclusive; the focused product contracts and runtime
  smoke are the standalone evidence.
- The Benchmark full suite produced no measurable progress within its earlier
  90-second gate and remains non-conclusive. It must not be represented as a
  pass until CI provides observable progress or useful sharding.

## Remaining release decisions

- complete the first hosted CI baseline and publish the initial stable release;
- make the first GHCR packages public before documenting anonymous pulls;
- move optional adapters through the proven seam one family at a time;
- add a GPU Ollama override only for explicitly supported hardware.
