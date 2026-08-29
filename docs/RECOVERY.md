# Recovery contract

Agent X separates ordinary same-host backups from portable disaster recovery.
The Backup page currently manages recovery inputs in the persistent
`recovery_data` Docker volume. Those inputs survive ordinary container
recreation, but they are not a coherent recovery point and do not protect
against host loss.

The repository defines and tests the portable bundle format, an offline
network-free verifier, and a supported disposable capture-and-restore drill.
The drill operates only on synthetic product fixtures in new Compose projects;
it never reads or mutates the default product volumes. Restore remains disabled
in the running website, and the drill is not a live-data export command.

## Portable v1 layout

```text
agentx-recovery-v1-<UTC>-<random>/
  manifest.json
  manifest.sha256
  artifacts/
    mongodb.archive.gz
    qdrant.collection.snapshot
    product-config.tar.gz
```

`manifest.json` is governed by `agentx.recovery-bundle/v1`. It binds one bundle
to an exact product version, `demo` or `full` profile, 40-character product
revision, five source-image digests, MongoDB and Qdrant versions, a UUID bundle
identity, and one completed `quiesced-compose` capture window. Core, Benchmark,
and RAG must all have been observed stopped while the three artifacts were
captured.

Each artifact has one fixed role, path, media type, byte count, and lowercase
SHA-256 digest. The product-config artifact may contain only the exact seven
secret-free source IDs declared by the contract. Logs, credentials, runtime
environment files, private adapters, Ollama model volumes, deployment-specific
Benchmark configuration, prior recovery inventories, personal/AIOps data,
crontabs, caches, and build output are explicitly excluded.

The manifest always records `restoreVerified: false`. A later rehearsal receipt
will reference the immutable manifest hash; it must never rewrite a captured
bundle to claim success after the fact.

## Offline verification

When a conforming bundle exists, verify it without network access:

```bash
node scripts/verify-recovery-bundle.js \
  --bundle /absolute/path/to/agentx-recovery-v1-... \
  --product-revision 0123456789abcdef0123456789abcdef01234567
```

The verifier rejects an unexpected directory entry, missing artifact, unsafe
or linked path, non-regular file, oversized manifest, malformed schema or
identity, incomplete capture, revision mismatch, and byte or digest mismatch.
It streams artifact hashes and performs no restore or other mutation.

SHA-256 detects corruption. It does not encrypt the payload or prove who
created it; portable bundles must be handled as sensitive product data.

## Supported isolated recovery drill

Supply the three exact candidate product image references and revision. MongoDB,
Qdrant, and the internal Node transport helper are loaded from the reviewed
`config/container-image-pins.json` inventory; explicit `--mongo-image` and
`--qdrant-image` values are accepted only when they equal that inventory.

```bash
node scripts/run-recovery-drill.js \
  --output /new/private/path/recovery-drill-receipt.json \
  --run-scope release-012345 \
  --expected-candidate-revision 0123456789abcdef0123456789abcdef01234567 \
  --candidate-core-image ghcr.io/windriderqc/agentx-core@sha256:<64-hex> \
  --candidate-benchmark-image ghcr.io/windriderqc/agentx-benchmark@sha256:<64-hex> \
  --candidate-rag-image ghcr.io/windriderqc/agentx-rag@sha256:<64-hex>
```

The recovery CLI also accepts the shorter `--receipt`, `--product-revision`,
and `--core-image`/`--benchmark-image`/`--rag-image` aliases. The receipt
destination must not already exist. `--product-version` defaults
to the one version shared by Core, Benchmark, and RAG; `--product-profile`
defaults to `demo` and also accepts `full`. `--run-scope` may instead be set as
`AGENTX_RECOVERY_DRILL_RUN_SCOPE` so an outer runner can perform an independent
label-scoped residue audit.

The driver performs one complete sequence:

1. Render and hash a six-service topology with no published ports, bind mounts,
   external volumes, or non-project networks. Pull only exact image references.
2. Start a fresh source, seed schema-compatible Prompt, RAG, and Benchmark
   fixtures through the exact product images, stop Core, Benchmark, and RAG,
   and confirm all writers are stopped while MongoDB and Qdrant remain ready.
3. Capture one MongoDB archive, one Qdrant collection snapshot, and the exact
   product-config allowlist. Hash the artifacts, write the v1 manifest and
   checksum, atomically publish inside the disposable workspace, and verify it.
4. Destroy the source containers and volumes before starting either target.
5. Corrupt one snapshot byte, require offline verification to reject it, and
   prove a fresh negative target has identical empty hashes before and after.
6. Start another fresh target, verify the original bundle before mutation,
   restore MongoDB and Qdrant, and compare source/restored record counts and
   canonical SHA-256 state hashes.
7. Only after restore, start the exact Core, Benchmark, and RAG images. Require
   their version, profile, and revision identities to match and pass bounded
   Prompt, RAG, Benchmark, vector, and rendered-page journeys.
8. Remove the three exact Compose projects, their networks and volumes, and the
   temporary bundle workspace. Any failed assertion prevents receipt creation.

The immutable JSON receipt uses `agentx.recovery-drill-receipt/v1`. It retains
the rendered topology hash, exact five source image digests, manifest hash,
dependency versions/digests, phase timings, source/restored state hashes, exact
product identities, explicit journey and cleanup assertions, and explicit
privacy flags. It contains no service addresses, local paths, raw fixture or
document content, tokens, credentials, or secrets. The bundle and raw fixture
state are deliberately deleted rather than published as CI evidence.

## Live-data capture remains separate

The Backup page still manages same-host recovery inputs rather than a coherent
portable recovery point. A future operator export for real data must implement
the same quiescence, allowlist, integrity, atomic publication, service-resume,
and destination-verification rules without adding a default host bind or
enabling online restore. A passed drill receipt proves the tested images and
portable format; it does not claim that uncaptured production data is backed up.
