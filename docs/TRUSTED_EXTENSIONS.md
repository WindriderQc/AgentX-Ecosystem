# Trusted extensions

Agent X Core exposes one deliberately small in-process seam for separately
owned trusted extensions. The seam lets an operator add a private application
without forking Core or duplicating inference, routing, streaming, telemetry,
PromptConfig, or conversation persistence.

No extension is bundled or enabled by the product. The default `demo` profile
never loads extensions. Loading requires all of the following:

1. `AGENTX_PROFILE=full`;
2. `AGENTX_EXTENSION_MODULES` set to one absolute module path or a JSON array
   of absolute module paths;
3. a separately installed, operator-pinned module.

Example operator configuration:

```text
AGENTX_PROFILE=full
AGENTX_EXTENSION_MODULES=["/opt/agentx-extensions/private-application"]
```

The module exports a synchronous manifest:

```js
module.exports = {
  id: 'private-application',
  version: '1.0.0',
  capabilities: ['private-application'],
  register({
    contractVersion,
    app,
    express,
    mongoose,
    logger,
    standardJsonParser,
    conversationLifecycle,
    runtimeServices,
    security,
    extensionRoot
  }) {
    const router = express.Router();
    router.get('/status', (_req, res) => res.json({ ok: true }));
    app.use('/api/private-application', standardJsonParser, router);
  }
};
```

Contract version 2 provides the Express application, Express and Mongoose
instances already used by Core, the Core logger and standard JSON parser, the
active runtime profile, the extension's resolved root, and the versioned
`conversationLifecycle`, `runtimeServices`, and `security` services. Additive
Core services carry their own contract version so extension startup can fail
closed when a required bounded interface is unavailable. Extensions may create
their own collections; Core-owned transcript lifecycle must go through
`conversationLifecycle`, never direct collection access.

Every conversation lifecycle operation is scoped by both `userId` and
`promptName`. Its current capabilities are:

- list and get conversations, including explicitly requested transcripts;
- verify prompt ownership and list scoped IDs;
- rename, archive, restore, and permanently delete conversations.

`runtimeServices` contract version 1 exposes two frozen capabilities:

- `inference.execute(request, { signal })` executes chat, generate, or embedding
  work through Core-owned routing, benchmark-claim admission, resident-model
  context policy, telemetry, and configured cloud-provider egress. It returns
  actual routed model/host metadata. Streaming returns the upstream readable
  stream, and the caller's `AbortSignal` cancels the upstream request.
- `routing.getEffectiveSnapshot(options)` returns an immutable, read-only view
  of effective task routing, host preferences, resolved context/capability
  evidence, and an optional active-model catalog. It does not expose mutable
  collections.

The executor accepts only the bounded generic request surface documented by its
mode, including an allowlisted OpenAI `reasoning_effort` for configured cloud
providers, and rejects local runtime-placement options. A matching resident pin
owns context and keep-alive even when the translated protocol supplied a
different keep-alive. Extensions translate their external protocol into that
surface; they do not choose an inference host, call a model server directly,
copy HostPreference logic, or forward caller credentials to an upstream
provider. Provider secrets remain inside Core.

`security` contract version 1 exposes Core's operator-access checks and
middleware. Use these helpers for extension control paths instead of copying
token, loopback, or same-origin policy. All extension routes also remain behind
the Core profile guard, public-exposure guard, JSON bounds, sanitization, and
general API limiter.

Paths must be absolute and are resolved before loading. Invalid manifests,
duplicate real paths, duplicate IDs, duplicate capability ownership, or
asynchronous registration fail startup. Registration occurs after Core's
general API limiter and before built-in routes, so extensions share admission
controls and can install privacy middleware in front of Core-owned paths.

Extensions run with Core's process privileges. Treat them as deployment code:
review and pin them independently, mount them read-only, and never load an
untrusted checkout. Extension source, secrets, mounts, and deployment remain
outside this repository. The product's Compose defaults include none of them.

This is not a marketplace, discovery system, second router, or operations
framework. Core owns only the loader and injected contracts; each extension
owns its application behavior and data.
