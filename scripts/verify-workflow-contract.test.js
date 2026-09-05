'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const {
  verifyProfilerAuthorityReceipt,
} = require('../benchmark/src/services/profiler/profilerAuthorityReceipt');

const root = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

function section(source, start, end) {
  const startIndex = source.indexOf(start);
  assert.notEqual(startIndex, -1, `missing workflow section ${start}`);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(endIndex, -1, `missing workflow section ${end}`);
  return source.slice(startIndex, endIndex);
}

function executeMongoSeed(relative) {
  const collections = new Map();
  const collection = name => ({
    countDocuments: () => (collections.get(name) || []).length,
    insertOne: document => {
      collections.set(name, [...(collections.get(name) || []), document]);
    },
    insertMany: documents => {
      collections.set(name, [...(collections.get(name) || []), ...documents]);
    },
  });
  const db = new Proxy({ getCollection: collection }, {
    get(target, property) {
      if (property in target) return target[property];
      return collection(String(property));
    },
  });
  const ObjectId = value => ({
    value,
    toString() { return value; },
  });

  vm.runInNewContext(read(relative), { db, ObjectId, Date, print() {}, require }, { timeout: 1_000 });
  return collections;
}

test('live cancellation seed carries an exact profiler authority receipt', () => {
  const collections = executeMongoSeed('e2e/fixtures/live-cancellation-seed.mongodb.js');
  const [model] = collections.get('modelprofiles');
  const [evidence] = collections.get('modelperformanceprofiles');
  const readiness = model.readiness.primary;
  const receipt = readiness.authorityReceipt;

  assert.equal(readiness.profileDepth, 'standard');
  assert.equal(readiness.benchmarkQualified, true);
  assert.equal(readiness.qualificationReason, null);
  assert.equal(readiness.measurementReliability, 'medium');
  assert.equal(String(readiness.evidenceId), String(evidence._id));
  assert.equal(receipt.source, 'profiler_pipeline');
  assert.equal(receipt.version, 3);
  assert.equal(receipt.evidenceId, String(evidence._id));
  assert.match(receipt.digest, /^[a-f0-9]{64}$/);
  assert.equal(readiness.stale, false);
  assert.equal(evidence.profile.benchmarkQualified, true);
  assert.deepEqual(
    JSON.parse(JSON.stringify(readiness.artifact)),
    JSON.parse(JSON.stringify(evidence.artifact)),
  );

  assert.equal(verifyProfilerAuthorityReceipt(readiness, evidence, {
    modelName: evidence.modelName,
    hostId: evidence.hostId,
  }), true);
});

test('release contract requires exact green CI and prior explicitly authorized lifecycle evidence', () => {
  const workflow = read('.github/workflows/publish-images.yml');
  const contract = section(workflow, '\n  release-contract:', '\n  publish:');

  assert.match(contract, /permissions:\s*\n\s+actions: read\s*\n\s+contents: read/);
  assert.match(contract, /packages: read/);
  assert.doesNotMatch(contract, /packages: write/);
  assert.match(contract, /source_sha: \$\{\{ steps\.source\.outputs\.sha \}\}/);
  assert.match(contract, /source_sha="\$\(git rev-parse HEAD\)"/);
  assert.match(contract, /\^\[A-Za-z0-9_\]\[A-Za-z0-9_\.\-\]\{0,127\}\$/);
  assert.match(contract, /build metadata with '\+' is unsupported/);
  assert.match(contract, /workflowId, eventName\) =>[\s\S]*?head_sha: sourceSha[\s\S]*?branch: 'main'[\s\S]*?event: eventName/);
  assert.match(contract, /exactRuns\('ci\.yml', 'push'\)/);
  assert.match(contract, /exactRuns\('publish-images\.yml', 'workflow_dispatch'\)/);
  assert.match(contract, /Date\.parse\(run\.created_at\) <= publishedAt\)[\s\S]*?\.sort\([\s\S]*?const latest = runs\[0\];[\s\S]*?Date\.parse\(String\(latest\?\.updated_at/);
  assert.doesNotMatch(contract, /\.filter\([\s\S]*?Date\.parse\(run\.updated_at\)/);
  assert.match(contract, /updatedAt > publishedAt[\s\S]*?did not complete before release publication/);
  assert.match(contract, /latest\.status !== 'completed'/);
  assert.match(contract, /latest\.conclusion !== 'success'/);
  assert.match(contract, /agentx-candidate-image-manifest-\$\{sourceSha\}-\$\{lifecycleRun\.run_attempt\}/);
  assert.match(contract, /agentx-immutable-upgrade-rollback-evidence-\$\{sourceSha\}-\$\{lifecycleRun\.run_attempt\}/);
  assert.match(contract, /agentx-mongodb-qdrant-recovery-evidence-\$\{sourceSha\}-\$\{lifecycleRun\.run_attempt\}/);
  assert.match(contract, /matches\.length !== 1 \|\| matches\[0\]\.expired \|\| matches\[0\]\.size_in_bytes <= 0/);
  assert.match(contract, /github-token: \$\{\{ github\.token \}\}[\s\S]*?run-id: \$\{\{ steps\.release-gates\.outputs\.lifecycle_run_id \}\}/);
  assert.match(contract, /--candidate-artifact release-lifecycle\/candidate/);
  assert.match(contract, /--upgrade-artifact release-lifecycle\/upgrade/);
  assert.match(contract, /--recovery-artifact release-lifecycle\/recovery/);
  assert.match(contract, /compare the candidate image set field-for-field/);
  assert.match(contract, /upgrade_previous_tag/);
  assert.match(contract, /getReleaseByTag/);
  assert.match(contract, /agentx-\$\{tag\}-images\.json/);
  assert.match(contract, /--previous release-lifecycle\/previous-image-manifest\.json/);
  assert.match(contract, /--expected-previous-revision/);
  assert.match(contract, /--expected-previous-tag/);
  assert.match(contract, /upgrade_previous_identity_evidence_mode/);
  assert.match(contract, /Reconstruct the exact legacy baseline from attached bytes and live OCI labels/);
  assert.match(contract, /--pull-exact-images true/);
  assert.match(contract, /baseline_args\+=\(--previous-baseline release-lifecycle\/previous-release-baseline\.json\)/);
  assert.match(contract, /elif \[ "\$mode" != "in-band-health" \]/);
});

test('green main CI or manual exact-SHA publication creates one immutable candidate manifest', () => {
  const workflow = read('.github/workflows/publish-images.yml');
  const publish = section(workflow, '\n  publish:', '\n  candidate-manifest:');
  const candidate = section(workflow, '\n  candidate-manifest:', '\n  previous-stable:');

  const trigger = section(workflow, 'on:', '\n\npermissions:');
  assert.match(trigger, /workflow_run:[\s\S]*workflows: \[product-ci\][\s\S]*types: \[completed\][\s\S]*branches: \[main\]/);
  assert.match(trigger, /workflow_dispatch:/);
  assert.match(trigger, /source_sha:[\s\S]*required: true[\s\S]*confirmation:[\s\S]*required: true/);
  assert.doesNotMatch(trigger, /\n\s+push:/);
  assert.match(workflow, /github\.event\.workflow_run\.head_sha/);
  assert.match(workflow, /CI_CONCLUSION[\s\S]*CI_EVENT[\s\S]*CI_BRANCH/);
  assert.match(workflow, /Automatic publication requires one successful Product CI push on main/);
  assert.match(workflow, /Automatic publication checkout does not match the completed Product CI commit/);
  assert.match(workflow, /lifecycle_required: \$\{\{ steps\.source\.outputs\.lifecycle_required \}\}/);
  assert.match(workflow, /git diff --name-only "\$\{source_sha\}\^" "\$source_sha" \| grep -Eq/);
  assert.match(workflow, /\.github\/workflows\/\(ci\|publish-images\)\\\.yml/);
  assert.match(workflow, /Manual publication requires confirmation=PUBLISH/);
  assert.match(workflow, /source_sha" =~ \^\[0-9a-f\]\{40\}\$/);
  assert.match(workflow, /"\$GITHUB_REF" != "refs\/heads\/main"/);
  assert.match(workflow, /"\$source_sha" != "\$GITHUB_SHA"/);
  assert.match(workflow, /git merge-base --is-ancestor "\$source_sha" origin\/main/);
  assert.match(publish, /if: github\.event_name == 'workflow_dispatch' \|\| github\.event_name == 'workflow_run'/);
  assert.match(publish, /group: publish-product-image-\$\{\{ matrix\.service \}\}-\$\{\{ needs\.release-contract\.outputs\.source_sha \}\}/);
  assert.match(publish, /type=raw,value=sha-\$\{\{ needs\.release-contract\.outputs\.source_sha \}\}/);
  assert.match(publish, /AGENTX_BUILD_REVISION=\$\{\{ needs\.release-contract\.outputs\.source_sha \}\}/);
  assert.match(publish, /Detect an existing immutable image/);
  assert.match(publish, /Registry lookup failed without an exact not-found response/);
  assert.match(publish, /manifest unknown/);
  assert.match(publish, /ERROR: \$\{immutable_ref\}: not found/);
  assert.doesNotMatch(publish, /\b404\b/);
  assert.match(publish, /if: steps\.immutable\.outputs\.exists != 'true'/);
  assert.match(publish, /schema: 'agentx\.immutable-image-receipt\/v1'/);
  assert.match(publish, /ref: `\$\{image\}@\$\{digest\}`/);
  assert.match(publish, /agentx-immutable-image-receipt-\$\{\{ matrix\.service \}\}-\$\{\{ needs\.release-contract\.outputs\.source_sha \}\}-\$\{\{ github\.run_attempt \}\}/);
  assert.match(candidate, /needs: \[release-contract, publish\]/);
  assert.match(candidate, /merge-multiple: true/);
  assert.match(candidate, /assemble-candidate-image-manifest\.js/);
  assert.match(candidate, /--commit "\$\{\{ needs\.release-contract\.outputs\.source_sha \}\}"/);
  assert.match(candidate, /agentx-candidate-image-manifest-\$\{\{ needs\.release-contract\.outputs\.source_sha \}\}-\$\{\{ github\.run_attempt \}\}/);
  assert.match(candidate, /retention-days: 30/);
  assert.doesNotMatch(publish, /(?:value=|:)(?:latest|test)(?:\s|$)/m);
});

test('previous stable manifest gates parallel exact-digest upgrade and recovery drills', () => {
  const workflow = read('.github/workflows/publish-images.yml');
  const previous = section(workflow, '\n  previous-stable:', '\n  upgrade-rollback:');
  const upgrade = section(workflow, '\n  upgrade-rollback:', '\n  recovery-drill:');
  const recovery = section(workflow, '\n  recovery-drill:', '\n  release-record:');

  assert.match(previous, /!release\.draft && !release\.prerelease/);
  assert.match(previous, /if: needs\.release-contract\.outputs\.lifecycle_required == 'true'/);
  assert.match(previous, /agentx-\$\{stable\.tag_name\}-images\.json/);
  assert.match(previous, /matches\.length !== 1 \|\| matches\[0\]\.size <= 0/);
  assert.match(previous, /releases\/assets\/\$\{PREVIOUS_ASSET_ID\}/);
  assert.match(previous, /--previous previous-stable-image-manifest\.json/);
  assert.match(previous, /--expected-candidate-revision/);
  assert.match(previous, /--expected-previous-tag "\$\{\{ steps\.stable\.outputs\.tag \}\}"/);
  assert.match(previous, /previous_manifest_sha256/);
  assert.match(previous, /previous_identity_evidence_mode/);

  for (const job of [upgrade, recovery]) {
    assert.match(job, /if: needs\.release-contract\.outputs\.lifecycle_required == 'true'/);
    assert.match(job, /needs: \[release-contract, candidate-manifest, previous-stable\]/);
    assert.match(job, /--candidate-artifact candidate-artifact/);
    assert.match(job, /config\/container-image-pins\.json/);
    assert.match(job, /packages: read/);
    assert.match(job, /docker\/login-action@v4/);
    assert.match(job, /if: always\(\)/);
    assert.match(job, /label=com\.docker\.compose\.project=\$project/);
    assert.doesNotMatch(job, /docker (?:system|container|network|volume) prune/);
    assert.doesNotMatch(job, /< <\(docker (?:container|network|volume) ls/);
  }
  assert.match(upgrade, /node e2e\/run-upgrade-rollback\.js/);
  assert.match(upgrade, /packages: read/);
  assert.match(upgrade, /docker\/login-action@v4/);
  assert.match(upgrade, /assemble-previous-release-baseline\.js/);
  assert.match(upgrade, /if: needs\.previous-stable\.outputs\.identity_evidence_mode == 'legacy-oci-bound'/);
  assert.match(upgrade, /--pull-exact-images true/);
  assert.match(upgrade, /--previous-manifest previous-stable-image-manifest\.json/);
  assert.match(upgrade, /--previous-manifest-sha256/);
  assert.match(upgrade, /--previous-baseline previous-release-baseline\.json/);
  assert.match(upgrade, /AGENTX_UPGRADE_ROLLBACK_PREVIOUS_CORE_IMAGE: \$\{\{ needs\.previous-stable\.outputs\.core_ref \}\}/);
  assert.match(upgrade, /AGENTX_UPGRADE_ROLLBACK_CANDIDATE_CORE_IMAGE: \$\{\{ needs\.candidate-manifest\.outputs\.core_ref \}\}/);
  assert.match(upgrade, /--expected-previous-revision "\$\{\{ needs\.previous-stable\.outputs\.previous_revision \}\}"/);
  assert.match(upgrade, /agentx-immutable-upgrade-rollback-evidence-\$\{\{ needs\.release-contract\.outputs\.source_sha \}\}-\$\{\{ github\.run_attempt \}\}/);
  assert.match(upgrade, /retention-days: 30/);
  assert.match(recovery, /node scripts\/run-recovery-drill\.js/);
  assert.match(recovery, /--candidate-core-image "\$\{\{ needs\.candidate-manifest\.outputs\.core_ref \}\}"/);
  assert.match(recovery, /--run-scope "\$scope"/);
  assert.match(recovery, /for phase in source negative positive/);
  assert.match(recovery, /agentx-mongodb-qdrant-recovery-evidence-\$\{\{ needs\.release-contract\.outputs\.source_sha \}\}-\$\{\{ github\.run_attempt \}\}/);
  assert.match(recovery, /retention-days: 30/);
});

test('only release-record can promote digest-guarded release tags after lifecycle revalidation', () => {
  const workflow = read('.github/workflows/publish-images.yml');
  const beforeRelease = workflow.slice(0, workflow.indexOf('\n  release-record:'));
  const releaseRecord = workflow.slice(workflow.indexOf('\n  release-record:'));

  assert.match(releaseRecord, /needs: release-contract/);
  assert.match(releaseRecord, /packages: write/);
  assert.match(releaseRecord, /run-id: \$\{\{ needs\.release-contract\.outputs\.lifecycle_run_id \}\}/);
  assert.match(releaseRecord, /--candidate-artifact release-lifecycle\/candidate/);
  assert.match(releaseRecord, /--previous release-lifecycle\/previous-image-manifest\.json/);
  assert.match(releaseRecord, /--upgrade-artifact release-lifecycle\/upgrade/);
  assert.match(releaseRecord, /--recovery-artifact release-lifecycle\/recovery/);
  assert.match(releaseRecord, /Reconstruct the exact legacy baseline again before release promotion/);
  assert.match(releaseRecord, /if: needs\.release-contract\.outputs\.previous_identity_evidence_mode == 'legacy-oci-bound'/);
  assert.match(releaseRecord, /--pull-exact-images true/);
  assert.match(releaseRecord, /baseline_args\+=\(--previous-baseline release-lifecycle\/previous-release-baseline\.json\)/);
  assert.match(releaseRecord, /elif \[ "\$mode" != "in-band-health" \]/);
  assert.match(releaseRecord, /Promote only the validated digest set/);
  assert.match(releaseRecord, /> "\$promotion_rows"/);
  assert.match(releaseRecord, /ERROR: \$\{release_ref\}: not found/);
  assert.match(releaseRecord, /Release-tag lookup failed without an exact target-ref not-found response/);
  assert.match(releaseRecord, /Release-tag recheck failed without an exact target-ref not-found response/);
  assert.match(releaseRecord, /imagetools create --tag "\$release_ref" "\$ref"/);
  assert.match(releaseRecord, /Refusing to overwrite \$release_ref/);
  assert.match(releaseRecord, /Release tag verification failed for \$release_ref/);
  assert.match(releaseRecord, /retention-days: 90/);
  assert.match(releaseRecord, /lifecycle-\$\{RELEASE_SHA\}-\$\{LIFECYCLE_ATTEMPT\}-upgrade-rollback\.json/);
  assert.doesNotMatch(workflow, /\$\{IMAGE\}:(?:latest|test)|value=(?:latest|test)|RELEASE_PRERELEASE/);
  assert.doesNotMatch(beforeRelease, /imagetools create --tag "\$release_ref"/);
});

test('Product CI remains non-publishing and retains its existing exact-SHA proofs', () => {
  const workflow = read('.github/workflows/ci.yml');

  assert.match(workflow, /permissions:\s*\n\s+contents: read/);
  assert.doesNotMatch(workflow, /packages: write|docker\/login-action|docker\/build-push-action|imagetools create/);
  assert.doesNotMatch(workflow, /^\s+node e2e\/run-upgrade-rollback\.js(?:\s|$)/m);
  assert.doesNotMatch(workflow, /^\s+node scripts\/run-recovery-drill\.js(?:\s|$)/m);
  assert.doesNotMatch(workflow, /name: agentx-candidate-image-manifest-/);
  assert.match(workflow, /node --test[^\n]*scripts\/assemble-candidate-image-manifest\.test\.js/);
  assert.match(workflow, /node --test[^\n]*scripts\/assemble-previous-release-baseline\.test\.js/);
  assert.match(workflow, /node --test[^\n]*scripts\/verify-lifecycle-evidence\.test\.js/);
  assert.match(workflow, /node --test e2e\/unit\/upgrade-rollback-receipt\.test\.js e2e\/unit\/run-upgrade-rollback\.test\.js/);
  assert.match(workflow, /node --test scripts\/bounded-response\.test\.js/);
  assert.match(workflow, /node --test shared\/recoveryBundleContract\.test\.js/);
  assert.match(workflow, /\/app\/scripts\/repo-coding-qualification\.js/);
  assert.match(workflow, /\/app\/data\/repo-tasks\/manifest\.json/);
  assert.match(workflow, /\/scripts\/bounded-response\.js/);
  assert.match(workflow, /--entrypoint git "\$benchmark_image" --version/);
  assert.match(workflow, /--network none --entrypoint node "\$benchmark_image"[\s\S]*?--dry-run --attempts 1 --ks 1/);
  assert.match(workflow, /DRY-RUN \(golden diffs, no model calls\)/);
  assert.match(workflow, /pass@1=1\.000/);
  assert.match(workflow, /name: agentx-release-evidence-\$\{\{ github\.sha \}\}-\$\{\{ github\.run_attempt \}\}[\s\S]*?retention-days: 30/);
  assert.match(workflow, /name: agentx-live-cancellation-evidence-\$\{\{ github\.sha \}\}-\$\{\{ github\.run_attempt \}\}[\s\S]*?retention-days: 30/);
  assert.doesNotMatch(workflow, /\n  image-builds:/);
});

test('Product PR renders demo evidence while main alone runs the full suite', () => {
  const workflow = read('.github/workflows/ci.yml');
  const firstRun = section(workflow, '\n  clean-first-run:', '\n  live-cancellation:');
  const live = workflow.slice(workflow.indexOf('\n  live-cancellation:'));

  assert.match(workflow, /fromJSON\(github\.event_name == 'pull_request'[\s\S]*ubuntu-latest[\s\S]*windows-latest/);
  assert.match(firstRun, /Start the supported full product profile[\s\S]*if: github\.event_name == 'push'/);
  assert.match(firstRun, /Verify packaged Benchmark operator scripts without rebuilding images[\s\S]*if: github\.event_name == 'push'/);
  assert.match(firstRun, /Rehearse a bounded RAG outage and verified recovery[\s\S]*if: github\.event_name == 'push'/);
  assert.match(firstRun, /Require the useful PR demo receipt set[\s\S]*github\.event_name == 'pull_request'/);
  assert.match(live, /if: github\.event_name == 'push'/);
});

test('live cancellation runs in a separate ephemeral Compose project with exact cleanup', () => {
  const workflow = read('.github/workflows/ci.yml');
  const topology = read('docker-compose.live-cancellation.yml');
  const live = workflow.slice(workflow.indexOf('\n  live-cancellation:'));

  assert.match(live, /if: github\.event_name == 'push'/);
  assert.match(live, /runs-on: ubuntu-latest/);
  assert.doesNotMatch(live, /^\s+needs:/m);
  assert.match(live, /project="agentx-live-cancel-\$\{GITHUB_RUN_ID\}-\$\{GITHUB_RUN_ATTEMPT\}"/);
  assert.match(live, /token="\$\(openssl rand -hex 32\)"/);
  assert.match(live, /::add-mask::\$token/);
  assert.match(live, /AGENTX_BUILD_REVISION=\$GITHUB_SHA/);
  assert.match(live, /--file docker-compose\.live-cancellation\.yml[\s\S]*?config --format json/);
  assert.match(live, /expectedServices = \['benchmark', 'core', 'mongo', 'ollama-fixture'\]/);
  assert.match(live, /internal !== true/);
  assert.match(live, /Object\.keys\(config\.volumes \|\| \{\}\)\.length !== 0/);
  assert.match(live, /docker\\\.sock/);
  assert.match(live, /up --detach --build --wait --wait-timeout 120 mongo ollama-fixture/);
  assert.equal((live.match(/exec -T /g) || []).length, 3);
  assert.match(live, /exec -T mongo[\s\S]*?live-cancellation-seed\.mongodb\.js/);
  assert.match(live, /exec -T ollama-fixture[\s\S]*?node \/app\/run-live-cancellation\.js/);
  assert.match(live, /exec -T ollama-fixture[\s\S]*?cat \/tmp\/agentx-live-cancellation\.json[\s\S]*?> \/tmp\/agentx-live-cancellation\.json/);
  assert.doesNotMatch(live, /exec --no-tty/);
  assert.doesNotMatch(live, /\bcp ollama-fixture:\/tmp\/agentx-live-cancellation\.json/);
  assert.match(topology, /WATCHDOG_INTERVAL_MS:\s*"3600000"/);
  assert.match(live, /node \/app\/run-live-cancellation\.js/);
  assert.match(live, /validateLiveCancellationReceipt\(receipt\)/);
  assert.match(live, /if: always\(\)[\s\S]*?down --volumes --remove-orphans --timeout 10/);
  for (const resource of ['container', 'network', 'volume']) {
    assert.match(live, new RegExp(`docker ${resource} (?:ls|list)[^\\n]*label=com\\.docker\\.compose\\.project=\\$project`));
  }
  assert.doesNotMatch(live, /docker (?:system|container|network|volume) prune/);
});
