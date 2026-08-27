# Install and update modes

Agent X supports three deliberately simple release modes.

Core, Benchmark, and RAG use the same product version. A release tag, the three
package versions, and published image tags must agree before publication.

The contract is executable. Pull requests and `main` verify service/package-lock
parity with:

```bash
node --test scripts/verify-release-contract.test.js
node scripts/verify-release-contract.js
```

Before creating a GitHub release, add `docs/releases/<tag>.md` and verify the
exact proposed tag:

```bash
node scripts/verify-release-contract.js --tag v0.1.1
```

The release workflow checks out that tag and runs the same tagged verification
before any image build can publish. A malformed tag, missing release notes, or
package/lock drift stops all three images.

## Stable release

This is the normal path for a friend, colleague, or customer. Start from the
latest non-prerelease GitHub release, then check out its tag:

```bash
git fetch --tags --prune
git checkout <release-tag>
```

Read the release notes before moving to a newer stable tag. Run the normal
Windows or Linux start command after updating. Stable container images use the
same release tag and `latest`; `latest` changes only for a stable release.

Publication is complete only after Product CI is green and the GitHub release
records the release tag, exact commit, release notes, and immutable digests for
Core, Benchmark, and RAG together. The release workflow attaches this receipt
as `agentx-<tag>-images.json` after all three image publications succeed. Do not
infer success from `latest` alone.

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

## Test channel

Advanced users may follow `main` and the moving `test` image tags. This channel
can change between stable releases and is not appropriate for unattended or
production deployment. Prefer the immutable `sha-<full-commit>` image tag when
reproducing a test result.

No channel contains a personal hostname, credential, model download, or remote
production default. Advanced operators may keep their own hosts, integrations,
local documentation, and secrets in a separate private workspace; they do not
need to fork product code. This repository does not create or prescribe that
workspace.
