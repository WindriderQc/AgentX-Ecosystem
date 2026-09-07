# Recovery contract

Agent X separates ordinary same-host backups from portable disaster recovery.
The Backup page currently manages recovery inputs in the persistent
`recovery_data` Docker volume. Those inputs survive ordinary container
recreation, but they are not a coherent recovery point and do not protect
against host loss.

The repository defines the portable bundle format
(`shared/recoveryBundleContract.js`). Restore remains disabled in the running
website.

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

## Integrity

SHA-256 detects corruption. It does not encrypt the payload or prove who
created it; portable bundles must be handled as sensitive product data.

## Live-data capture remains separate

The Backup page still manages same-host recovery inputs rather than a coherent
portable recovery point. A future operator export for real data must implement
the same quiescence, allowlist, integrity, atomic publication, service-resume,
and destination-verification rules without adding a default host bind or
enabling online restore.
