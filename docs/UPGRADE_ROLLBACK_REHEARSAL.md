# Immutable-image upgrade and rollback rehearsal

This controlled release rehearsal proves that one exact previous Core,
Benchmark, and RAG image set can be upgraded to one exact candidate set and
then rolled back while the same disposable MongoDB and Qdrant state remains
readable. It is release-test infrastructure, not a supported deployment
topology.

The runner accepts no product build context and no tag-only image. Each of the
six product inputs must resolve as `image[:label]@sha256:<64 hex>`. MongoDB and
Qdrant default to the reviewed digest references in
[`config/container-image-pins.json`](../config/container-image-pins.json); CI
may override them only with other digest references.

Every run also supplies the exact bytes of the previous release image manifest,
either with `--previous-manifest <file>` or
`--previous-manifest-base64 <canonical-base64>`. The optional
`--previous-manifest-sha256` must match those bytes when present. The runner
does not fetch manifests or images through an API; the caller downloads or
provides the asset.

Set a modern previous and candidate image set without selecting a release
version:

```powershell
$env:AGENTX_UPGRADE_ROLLBACK_PREVIOUS_CORE_IMAGE = 'ghcr.io/example/agentx-core@sha256:<previous-core-digest>'
$env:AGENTX_UPGRADE_ROLLBACK_PREVIOUS_BENCHMARK_IMAGE = 'ghcr.io/example/agentx-benchmark@sha256:<previous-benchmark-digest>'
$env:AGENTX_UPGRADE_ROLLBACK_PREVIOUS_RAG_IMAGE = 'ghcr.io/example/agentx-rag@sha256:<previous-rag-digest>'
$env:AGENTX_UPGRADE_ROLLBACK_CANDIDATE_CORE_IMAGE = 'ghcr.io/example/agentx-core@sha256:<candidate-core-digest>'
$env:AGENTX_UPGRADE_ROLLBACK_CANDIDATE_BENCHMARK_IMAGE = 'ghcr.io/example/agentx-benchmark@sha256:<candidate-benchmark-digest>'
$env:AGENTX_UPGRADE_ROLLBACK_CANDIDATE_RAG_IMAGE = 'ghcr.io/example/agentx-rag@sha256:<candidate-rag-digest>'
$env:AGENTX_UPGRADE_ROLLBACK_EXPECTED_PREVIOUS_REVISION = '<previous-40-character-commit>'
$env:AGENTX_UPGRADE_ROLLBACK_EXPECTED_CANDIDATE_REVISION = '<candidate-40-character-commit>'
$env:AGENTX_UPGRADE_ROLLBACK_PREVIOUS_MANIFEST = '<path-to-exact-previous-images.json>'
$env:AGENTX_UPGRADE_ROLLBACK_OUTPUT = 'test-results/upgrade-rollback-rehearsal.json'
node e2e/run-upgrade-rollback.js
```

The equivalent Bash environment variables have the same names. Each image can
instead use the matching `--previous-*-image` or `--candidate-*-image` option.
`--mongo-image` and `--qdrant-image` override the reviewed dependency pins.
The runner generates a unique `agentx-upgrade-rollback-*` Compose project
unless `--project` supplies an equally scoped unique name. A pre-existing
project fails before ownership or cleanup is assumed.

The CLI requires both distinct full source commits. It binds the previous
manifest's closed tag/version/commit/image content to the selected previous
refs, while allowing CI to supply an unpublished candidate digest set. The
lasting `release-bound` lane requires complete, exact in-band `/health`
identity in all three phases.

### One-time v0.1.1 bootstrap lane

The sole historical exception is the exact v0.1.1 release recorded in
[`config/legacy-release-baselines.json`](../config/legacy-release-baselines.json).
Supplying `--previous-baseline <wrapper.json>` selects this lane. The wrapper
must match `agentx.previous-release-baseline/v1` exactly, the previous manifest
must match the 1,029 release-asset bytes and reviewed SHA-256 exactly, and the
three selected previous refs must be the policy refs. A missing wrapper keeps
the strict modern lane; it never triggers fallback.

For the audited v0.1.1-to-candidate rehearsal, first place the exact attached
`agentx-v0.1.1-images.json` asset at the shown path, then run:

```powershell
node e2e/run-upgrade-rollback.js `
  --previous-core-image 'ghcr.io/windriderqc/agentx-core@sha256:7000ef7e85cf4ca23387bce1959f00f626aeb5e76ac4ba973441b05b0bd7d794' `
  --previous-benchmark-image 'ghcr.io/windriderqc/agentx-benchmark@sha256:4525c3c2c44bb4e91dac3964d7cf7be1a1216035905cbfef4d63fc616164747f' `
  --previous-rag-image 'ghcr.io/windriderqc/agentx-rag@sha256:763511e85ad0ca67403e7ba0a9039a661eaf6ae56303a97b71ee65535e4e1423' `
  --candidate-core-image 'ghcr.io/windriderqc/agentx-core@sha256:<candidate-core-digest>' `
  --candidate-benchmark-image 'ghcr.io/windriderqc/agentx-benchmark@sha256:<candidate-benchmark-digest>' `
  --candidate-rag-image 'ghcr.io/windriderqc/agentx-rag@sha256:<candidate-rag-digest>' `
  --expected-previous-revision '6888750556cecc5277bf36b91f64a27806ea42a5' `
  --expected-candidate-revision '<candidate-40-character-commit>' `
  --previous-manifest 'agentx-v0.1.1-images.json' `
  --previous-manifest-sha256 '9a6d1b84fec83bd6a42d2a79852d3ac3e4e17ab4b70b5bf7c59cdef350e4912a' `
  --previous-baseline 'e2e/fixtures/upgrade-rollback-v0.1.1-previous-release-baseline.json' `
  --output 'test-results/upgrade-rollback-rehearsal.json'
```

CI may generate the same closed wrapper with the exported helpers in
`e2e/upgrade-rollback-baseline.js`; the driver independently rechecks the live
images and does not trust wrapper claims as runtime evidence.

## Evidence and isolation

[`docker-compose.upgrade-rollback.yml`](../docker-compose.upgrade-rollback.yml)
uses one internal project network, three project-scoped named volumes for
MongoDB data/config metadata and Qdrant data, and
disposable container filesystems/tmpfs. It publishes no port, attaches no bind
mount or host gateway, declares no global container or volume name, and has no
`build` key. The runner checks the rendered model and five live containers,
including exact content identities, project labels, network membership,
mounts, health, and selected digest references.

The previous images receive one deterministic Core prompt record and one
Benchmark template record in MongoDB plus one RAG-compatible document/vector
point in Qdrant. Before upgrade, after upgrade, and after rollback, the control
probe verifies:

- exact Core, Benchmark, and RAG health identity;
- the Core prompt and Benchmark template through their read APIs;
- the RAG document list, detail, and chunk reads;
- the Qdrant vector dimension, point, and payload schema;
- exact MongoDB/Qdrant state fingerprints and fixture schema version.

Only the app containers are replaced. MongoDB and Qdrant container identities
must stay stable, and every state fingerprint must match the pre-upgrade
observation. This proves the bounded fixture's data and schema compatibility;
it does not claim live model inference, embedding quality, arbitrary migration
compatibility, or production recovery.

Candidate identity is always sourced solely from complete in-band `/health`
fields. In the bootstrap lane only, previous and rolled-back fields missing
from health may be supplied from the exact packaged `package.json`, rendered
and running `AGENTX_PROFILE=demo`, and OCI revision labels. Present health
fields must agree and are never overwritten. All three legacy images must also
match their exact runtime digest, OCI revision/version/source labels, packaged
version, HTTP 200 service/healthy status, and manifest binding; rollback
repeats the same per-field evidence.

The schema-v2 receipt kind is `agentx.upgrade-rollback-rehearsal`. Its fourteen
ordered assertions cover immutable inputs, isolated topology, all three image,
identity, and journey phases, upgrade and rollback compatibility, and zero
residue. It retains exact image digests, SHA-256 fingerprints of the full OCI
references, and separate hashes of the previous and candidate rendered Compose
configurations. `previousRelease` retains the tag, version, commit, manifest
SHA-256, profile, and identity evidence mode for both lanes. Bootstrap receipts
are `release-bound-bootstrap` and additionally retain the exact privacy-safe
`legacyBaseline` binding. Per-service identity records retain field-source
classes and closed verification booleans. Raw registry/repository text, OCI
source values, and image refs are not retained.

The closed validator rejects additional fields, addresses, URLs, credentials,
secrets, raw fixture content, raw database IDs, and raw
container/network/volume names. Only digests/fingerprints, service
version/profile/revision, counts, booleans, and configuration hashes remain.

Cleanup always runs after project ownership is established. Compose first
removes the exact project with its volumes and orphans; a bounded recovery pass
may remove only resources bearing that exact unique project label. The final
assertion requires zero containers, networks, and volumes. Any missing phase,
identity drift, digest mismatch, state change, topology violation, probe error,
or cleanup residue produces a privacy-safe failure receipt and nonzero exit.

Run the focused static and receipt tests with:

```bash
cd e2e
npm run test:upgrade-rollback:unit
```
