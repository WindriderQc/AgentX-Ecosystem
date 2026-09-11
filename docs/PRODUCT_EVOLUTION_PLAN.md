# Agent X product priorities

Agent X is a local workspace for chatting with models, finding information in
personal documents, and comparing model behavior. This plan covers Core,
Benchmark, RAG, and shared product code. Private operations and external
assistants stay outside this repository.

## Product direction

Focus on useful features, lean code, a clear interface, and documentation that
matches the shipped behavior. Each page should explain its primary task, show
what is available, and help the user recover when a dependency is missing.
Advanced controls belong behind deliberate disclosure.

The supported product and runtime are described in [README](../README.md) and
[Architecture](ARCHITECTURE.md). This is a private-LAN prototype with no built-in
authentication; see [Security](../SECURITY.md).

## Current experience

| Area | Available flow |
| --- | --- |
| Chat | Send and stream a reply, stop and retain partial text, choose a model, inspect routing, and recover from a missing runtime. |
| Prompts | Browse, edit, save, and compare prompt behavior on the same model. |
| Knowledge | Add a document, search for supporting passages, inspect the exact source, and browse indexed documents with filters and pagination. |
| Compare models | Prepare exact installed models, choose a judge, apply Quick comparison or custom settings, follow execution and judging, and inspect results. |
| Full-profile workspaces | Inspect work, schedules, memory proposals, system status, and backups. These capabilities remain available through the full profile. |

Quick comparison checks a common, bounded context for two prepared local models
through the execution contract, then measures both on the same Basic prompts.
It explains missing or incompatible preparation before applying settings.
The [demo guide](DEMO.md) describes
the complete flow and its limits.

## Next improvements

1. **Observe first-time use.** Have someone start from the README and complete
   Chat, Knowledge, and a small comparison. Fix the confusing steps they
   encounter, including mobile and keyboard interactions.
2. **Make results easier to use.** Help people compare responses, speed, and
   scores for their own tasks. Show sample size, missing measurements, and
   judging limitations alongside any conclusion.
3. **Simplify code while changing features.** Reuse existing service contracts
   and shared controls, remove duplication in touched code, and keep focused
   modules. Avoid broad rewrites without a concrete user benefit.
4. **Improve recovery confidence.** Rehearse backup export, isolated restore,
   upgrade, and rollback before expanding recovery promises. Current behavior
   and limitations belong in [Recovery](RECOVERY.md).
5. **Keep full-profile workflows useful.** Exercise work cancellation and
   memory proposal approval/application through their actual owners. Improve
   these flows without adding private adapter implementations to Product.

## How changes are checked and shared

Run the affected service contracts, including Mongo integration where relevant,
and inspect changed journeys in a real browser. Check success, unavailable
states, retry, compact layouts, and opened advanced controls. Retain failure
logs; a successful retry alone does not establish a fix. See [Testing](TESTING.md).

Existing CI runs the three service suites and renders Compose. A successful
main build publishes the three product images at its exact commit and updates
latest. Publication does not deploy a running installation. There are no extra
release scorecards, CI gates, or scheduled qualification jobs implied by this plan.

For a shareable release, keep all three service versions aligned, describe the
features and upgrade implications in release notes, and record the exact commit
and image set. Follow [Install and update](RELEASES.md). Keep generated validation
output, secrets, local endpoints, and model data out of the repository.
