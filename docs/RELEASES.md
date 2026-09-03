# Install and update modes

Agent X supports three deliberately simple release modes.

Core, Benchmark, and RAG use the same product version. A release tag, the three
package versions, and published image tags must agree before publication.
Published images also embed the source commit in `AGENTX_BUILD_REVISION`; each
service exposes it with the product version and active profile from `/health`.

The contract is executable. Pull requests and `main` verify service/package-lock
parity with:

```bash
node --test scripts/verify-release-contract.test.js
node scripts/verify-release-contract.js
```

Before creating a GitHub release, add `docs/releases/<tag>.md` and verify the
exact proposed tag:

```bash
NEW_RELEASE_TAG=v0.1.2 # example; replace with the newly chosen version
node scripts/verify-release-contract.js --tag "$NEW_RELEASE_TAG"
```

Changes on `main` that have not been assigned a new version are recorded in
[`docs/releases/UNRELEASED.md`](releases/UNRELEASED.md). Published release notes
are historical records: do not add later work to `v0.1.1` or reuse that tag.
Before the next release, choose a new version, update all three package and
lockfile versions together, and move the applicable unreleased entries into the
new tag-specific note. Release tags must also be valid Docker/OCI tags (at most
128 characters and no SemVer `+build` metadata), because the exact Git tag is
used for the three promoted container references.

A successful `product-ci` run for a `main` push automatically starts the image
workflow for that exact tested commit. It publishes the commit once under its
immutable `sha-<full-commit>` references and combines the three unique service
receipts into one closed candidate manifest. A manual dispatch on `main` with
the exact full commit and literal confirmation `PUBLISH` remains available for
an explicit lifecycle run or retry. Exact-digest upgrade/rollback and
MongoDB/Qdrant recovery drills run only for such a manual lifecycle or when the
merged commit changes the Docker, dependency-pin, or lifecycle implementation;
ordinary application commits do not repeat them. Candidate manifests and any
produced privacy-safe lifecycle receipts remain exact-commit-and-attempt
artifacts with 30-day retention.

The first upgrade rehearsal has one deliberately narrow bootstrap exception:
the previous `v0.1.1` images predate the complete in-band health identity. The
workflow accepts them only when the attached manifest's exact bytes match the
single committed allowlist entry, its tag, commit, and all three digests match,
and every pulled image exposes the allowlisted OCI revision, version, and
source labels. It then records a closed `legacy-oci-bound` wrapper and uses that
identity mode only for the previous and rolled-back phases. The candidate and
all recovery evidence still require live in-band health identity. Later
previous releases use the normal `in-band-health` path; there is no wildcard or
generic legacy fallback.

For a GitHub release, the workflow checks out the tag and resolves it to one
full commit. With read-only Actions permission it requires both the latest
successful `product-ci` main-push run and the latest successful prior,
manually dispatched lifecycle run for that exact commit. It
downloads all three lifecycle artifacts from that exact run attempt, revalidates their closed
schemas, and compares every candidate service image, digest, and digest
reference binding before release-tag promotion. A green branch badge, a run
for another revision, an expired or ambiguous artifact, a failed receipt, or a
candidate mismatch is insufficient. If 30-day lifecycle retention has elapsed,
manually dispatch the image workflow again for that exact commit before
publishing the release.
The release gate also downloads the exact previous-release asset named by the
validated upgrade receipt and rebinds its bytes, digest set, revision, and tag
before promotion. When that receipt names the one-time `v0.1.1` bootstrap, both
the read-only release contract and the promotion job repull the exact allowlisted
digests, recheck their OCI labels, reconstruct the closed baseline wrapper, and
pass it into lifecycle validation. Normal later baselines omit the wrapper and
remain strict `in-band-health`; supplying or omitting a wrapper in the wrong
lane fails closed.

The three lifecycle artifact names intentionally bind one workflow run attempt.
After a failed lifecycle run, use **Re-run all jobs**. A partial failed-job
rerun cannot borrow a successful producer artifact from an earlier attempt and
therefore fails closed instead of assembling mixed-attempt release evidence.

## Live release evidence

Run the supported profile before publishing and retain its JSON receipt:

```bash
candidate_revision="$(git rev-parse HEAD)"
node scripts/verify-release-evidence.js \
  --profile demo \
  --expected-revision "$candidate_revision" \
  --output reports/release-evidence.json
```

This gate fails closed on unhealthy required dependencies, mismatched service
version/profile/revision, stale health observations, failed registered pages,
and—for the full profile—missing, stale, inconsistent, or contradictory
ecosystem evidence. Its contradiction budget is zero. Optional Ollama
availability is recorded but never promoted to a release prerequisite.

`--expected-revision` binds all three live health identities to the source
revision under test; the equivalent `AGENTX_EXPECTED_REVISION` environment
variable is available for automation. When it is omitted for a local
working-tree rehearsal, the receipt distinguishes a consistent shared revision
from one verified against an explicit expected revision. An `unknown` revision
always fails. Full-profile evidence additionally requires `verified` trust,
current freshness with zero stale or unknown sources, and exactly one profile,
version, and revision matching the live runtime. Freshness is measured when
each response is received, so request latency is not mistaken for clock skew.

The same running demo must pass the repository-owned browser gate described in
[`e2e/README.md`](../e2e/README.md). Product CI exercises the critical registry
at 1440 px and 375 px, checks document overflow and serious/critical Axe
findings, and completes the Playground and Courthouse keyboard journeys.
Successful Product CI runs retain the demo and full release receipts, plus the
paired degraded/recovery resilience receipts, in commit-and-attempt-named
workflow artifacts for 30 days. These artifacts are CI evidence; the release's
authoritative deployment record remains the attached immutable image manifest.

## Stable release

This is the normal path for a friend, colleague, or customer. Start from the
latest non-prerelease GitHub release, then check out its tag:

```bash
git fetch --tags --prune
git checkout <release-tag>
```

Read the release notes before moving to a newer stable tag. Run the normal
Windows or Linux start command after updating. Stable container images use the
same explicit release tag. The workflow does not publish or move `latest`;
operators must select a release tag or the attached digest set deliberately.

Stable-release promotion is complete only after Product CI, immutable candidate
publication, and the separate manual lifecycle run are green for the exact
tagged commit, and the GitHub release records
the release tag, exact commit, release notes, and immutable digests for Core,
Benchmark, and RAG together. Only the `release-record` job may create the
explicit release tags, and it does so from the already validated digest refs;
the release event never rebuilds the candidate. The workflow attaches the
authoritative `agentx-<tag>-images.json` manifest plus the exact candidate,
upgrade/rollback, and recovery receipts. A retained copy of the authoritative
manifest is also configured for 90-day workflow-artifact retention. Any
pre-existing `latest` tag may be stale and is not a supported publication
signal.

The first publication after green `main` CI creates each immutable SHA
reference. Job-level concurrency serializes attempts for the same service and
commit, and later automatic or manual attempts reuse and reverify the existing
digest.
A release fails if its previously rehearsed digest set is missing or changed;
it never rebuilds or replaces that set. An existing release tag is accepted
only when its digest already matches, and the workflow refuses to overwrite a
different digest. Promotion is coordinated and idempotent, but registries do
not provide a cross-repository transaction; controlled deployments must
therefore consume the three digest references from the attached manifest as
one set.

## Pinned deployment

Controlled deployments should pin all three service images by digest, never by
`latest` or a moving branch tag:

```text
ghcr.io/windriderqc/agentx-core@sha256:<digest>
ghcr.io/windriderqc/agentx-benchmark@sha256:<digest>
ghcr.io/windriderqc/agentx-rag@sha256:<digest>
```

Record the product commit, release tag, and three digests together. Updating is
an intentional configuration change followed by health checks and rollback to
the previous digest set if any service degrades.

Before promoting a controlled deployment, run the isolated
[immutable-image upgrade and rollback rehearsal](UPGRADE_ROLLBACK_REHEARSAL.md)
with the exact previous and candidate digest sets. It needs no preselected
release version, but its release-bound receipt requires both distinct full
commits and binds all image references without retaining registry addresses.

The repository applies the same rule to its runtime dependencies and build
bases. Reviewed MongoDB, Qdrant, and Node references live in
`config/container-image-pins.json` and include both an explicit version tag and
an immutable manifest digest. Before changing one, verify the new digest for
every supported architecture, update all governed declarations together, and
run:

```bash
node --test scripts/verify-container-image-pins.test.js
node scripts/verify-container-image-pins.js
docker compose --env-file config/agentx.env config
```

Dependency security updates are deliberate releases; a moving `latest`, major,
or convenience-only base tag is not a supported update mechanism.

## Main preview images

Advanced users may follow `main` and select the automatically published
immutable `sha-<full-commit>` image set for one exact green revision. The
workflow does not move
`test` or `latest`; any pre-existing moving tag may be stale. Main preview
images can change between stable releases and are not appropriate for
unattended or production deployment.

No supported image reference contains a personal hostname, credential, model
download, or remote production default. Advanced operators may keep their own
hosts, integrations, local documentation, and secrets in a separate private
workspace; they do not need to fork product code. This repository does not
create or prescribe that workspace.
