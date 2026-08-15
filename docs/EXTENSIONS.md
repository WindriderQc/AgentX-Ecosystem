# Trusted operations extensions

Agent X has one deliberately small extension seam for environment-specific
operations code. It lets a separate operations repository add adapters without
forking Core, Benchmark, RAG, or shared product code.

Extensions are disabled by default and are never loaded by the `demo` profile.
They load only when all of these conditions are true:

1. `AGENTX_PROFILE=full` is explicit;
2. `AGENTX_EXTENSION_MODULES` contains an absolute module path, or a JSON array
   of absolute module paths;
3. the operator mounts or installs that trusted module separately.

Example configuration for a user-owned operations workspace:

```text
AGENTX_PROFILE=full
AGENTX_EXTENSION_MODULES=["/opt/agentx-extensions/example-adapter"]
```

An extension exports a synchronous manifest:

```js
module.exports = {
  id: 'example-operations-adapter',
  version: '1.0.0',
  capabilities: ['example-capability'],
  register({ app, express, mongoose, logger, standardJsonParser }) {
    const router = express.Router();
    router.get('/status', (_req, res) => res.json({ ok: true }));
    app.use('/api/example', standardJsonParser, router);
  }
};
```

Paths must be absolute so a deployment cannot silently load a module from a
different working directory. Duplicate IDs or capability owners fail startup.
Registration is synchronous so routes are complete before Core accepts
traffic. A configured extension outside the full profile is ignored.

Extensions execute inside Core and therefore have Core's process permissions.
Treat them as trusted deployment code: mount them read-only, pin the product
image, review the operations repository independently, and never load an
untrusted checkout. Secrets stay in the operator's runtime environment and
must not be embedded in an extension or this repository.

The seam is intentionally not a plugin framework or third project. It is a
stable boundary between this product and a user's own configuration and
integration workspace.
