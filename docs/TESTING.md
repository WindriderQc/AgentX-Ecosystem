# Running Product tests

Run commands inside `core/` or `benchmark/`:

```text
npm ci
npm run test:prepare
npm run test:nodb
npm test -- --runTestsByPath tests/path/to/changed.test.js
npm test
```

`test:prepare` downloads the selected Mongo binary if needed, starts it, and
stops it. The default is MongoDB 7.0.24. Set `MONGOMS_VERSION` explicitly to
qualify another version. A cold download is preparation, not a test deadline.
No application model is downloaded.

`test:nodb` is a guarded pure subset, not the full unit suite. It rejects real
socket connections and child-process creation. Core includes verified utility
and UI contracts; Benchmark includes pure qualification contracts. Database
and executable repository fixture tests remain in `test:unit` and `npm test`.
Add pure tests to the no-DB config and verify that lane when expanding it.

`test:unit`, `test:integration`, `test:nodb`, and `npm test` use the same launcher.
It preserves Jest arguments/configuration, uses at most two workers by default,
and recycles full-suite workers above 256 MB between files. Explicit
`--maxWorkers` and `--runInBand` remain available. Multiple agents can run independent commands. Bound their
combined resource use to the machine; worktrees alone do not isolate a shared
external database.

Every invocation writes `test-results/<run-id>/run.log` and `result.json`.
Only a completed result with status zero is a pass. A hard-killed launcher can
leave a `running` receipt with null status; that is an incomplete execution.
The launcher allows 30 minutes by default (`TEST_RUN_TIMEOUT_MS` overrides it).
A timeout exits 124; an interruption or failed child never reports success.
Wait for the launcher and inspect its exit code. Retrying a failure is diagnostic,
not evidence that it was fixed. Do not add `--forceExit` to hide resource leaks.

Core starts one Mongo daemon per run and selects a fresh database per test file.
Setup awaits connection and ping; a failed daemon fails the run without silently
starting replacement servers. Files must create their own required indexes and
fixtures. The daemon stops on normal teardown or owner death. Cleanup targets
only owned processes; it does not sweep unrelated Mongo processes or temp data.
Benchmark's database suites own and stop their individual MongoMemoryServer
instances. Its test setup does not load the service `.env`.

External Mongo is opt-in: set `TEST_USE_EXTERNAL_MONGO=true` and an explicit
`MONGODB_URI_TEST` for a disposable test server. Core replaces its database name
with a run-and-file-specific name and preserves URI options. Benchmark supplies
the same naming to callers of its DB helper; suites explicitly constructing
MongoMemoryServer continue to use their own instances. Never point tests at a
production server. External test databases are retained for diagnosis; remove
only those belonging to your run.

Harness regression checks (from the repository root):

```text
node --test shared/testing/runJest.test.js shared/testing/listenLoopback.test.js
node scripts/verify-test-harness-interruption.js
```

For file isolation, run both `tests/integration/mongoIsolation.*.test.js` files
in Core, first serially and then with two workers. The fixtures deliberately
leave a marker behind and assert that another file cannot see it.

The interruption probe starts its own Mongo fixtures and deliberately terminates
Jest, exceeds the launcher deadline, and terminates the launcher itself. It checks
the recorded Mongo PIDs have exited for both services. Run it separately from
full-suite discovery in the same checkout because it creates temporary fixtures.
For new HTTP suites use `tests/helpers/testHttpServer.js`, await its harness, and
close it explicitly. It retains a verified IPv4 listener and pooled client sockets.
Windows route suites that do not qualify TCP peer identity can explicitly use
`{ transport: 'pipe', maxSockets: 4 }` for HTTP over a unique named pipe. Memory
Review uses this transport while preserving concurrent requests and real Mongo.
It authenticates with an explicit fixture token; authorization guards remain active.
Tests of outbound TCP identity continue to use real loopback TCP.
