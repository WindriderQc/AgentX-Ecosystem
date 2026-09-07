# Install and update modes

Agent X supports three deliberately simple release modes.

Core, Benchmark, and RAG use the same product version. A release tag, the three
package versions, and published image tags must agree before publication.
Published images also embed the source commit in `AGENTX_BUILD_REVISION`; each
service exposes it with the product version and active profile from `/health`.

Before creating a GitHub release, add `docs/releases/<tag>.md`.

Changes on `main` that have not been assigned a new version are recorded in
[`docs/releases/UNRELEASED.md`](releases/UNRELEASED.md). Published release notes
are historical records: do not add later work to `v0.1.1` or reuse that tag.
Before the next release, choose a new version, update all three package and
lockfile versions together, and move the applicable unreleased entries into the
new tag-specific note. Release tags must also be valid Docker/OCI tags (at most
128 characters and no SemVer `+build` metadata), because the exact Git tag is
used for the three promoted container references.

A successful `product-ci` run for a `main` push starts `publish-product-images`
for that exact commit. It builds the three images from `docker/*.Dockerfile`,
pushes them as `ghcr.io/windriderqc/agentx-<service>:sha-<full-commit>` and
`:latest`, and prints each image digest in the job summary. Those digests are
what a controlled deployment pins. A manual dispatch with `source_sha` rebuilds
one exact `main` commit.

## Stable release

This is the normal path for a friend, colleague, or customer. Start from the
latest non-prerelease GitHub release, then check out its tag:

```bash
git fetch --tags --prune
git checkout <release-tag>
```

Read the release notes before moving to a newer stable tag. Run the normal
Windows or Linux start command after updating. A release records its tag, exact
commit, release notes, and the three `sha-<full-commit>` image digests
together; deployments consume those three digests as one set.

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

The repository applies the same rule to its runtime dependencies and build
bases. Reviewed MongoDB, Qdrant, and Node references live in
`config/container-image-pins.json` and include both an explicit version tag and
an immutable manifest digest. Before changing one, verify the new digest for
every supported architecture, update all governed declarations together, and
render Compose:

```bash
docker compose --env-file config/agentx.env config
```

Dependency security updates are deliberate releases; a moving `latest`, major,
or convenience-only base tag is not a supported update mechanism.

## Main preview images

Advanced users may follow `main` and select the automatically published
immutable `sha-<full-commit>` image set for one exact green revision. The
`latest` tag follows the newest published `main` commit. Main preview
images can change between stable releases and are not appropriate for
unattended or production deployment.

No supported image reference contains a personal hostname, credential, model
download, or remote production default. Advanced operators may keep their own
hosts, integrations, local documentation, and secrets in a separate private
workspace; they do not need to fork product code. This repository does not
create or prescribe that workspace.
