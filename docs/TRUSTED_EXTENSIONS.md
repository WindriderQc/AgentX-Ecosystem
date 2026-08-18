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
    extensionRoot
  }) {
    const router = express.Router();
    router.get('/status', (_req, res) => res.json({ ok: true }));
    app.use('/api/private-application', standardJsonParser, router);
  }
};
```

Contract version 1 provides the Express application, Express and Mongoose
instances already used by Core, the Core logger and standard JSON parser, the
active runtime profile, the extension's resolved root, and the versioned
`conversationLifecycle` service. Extensions may create their own collections;
Core-owned transcript lifecycle must go through `conversationLifecycle`, never
direct collection access.

Every conversation lifecycle operation is scoped by both `userId` and
`promptName`. Its current capabilities are:

- list and get conversations, including explicitly requested transcripts;
- verify prompt ownership and list scoped IDs;
- rename, archive, restore, and permanently delete conversations.

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
