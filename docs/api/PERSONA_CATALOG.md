# Shared persona catalog

The catalog is a selectable projection of the existing PromptConfig collection.
`GET /api/prompts/catalog` returns the newest active version of each selectable
conversation persona. `GET /api/prompts/catalog/:name?version=N` resolves an
exact version, including an inactive historical version. Ordinary Prompts
management retains all versions, workflow assets and application definitions.

Presentation metadata uses the existing `uiConfig.layoutConfig` object:

```json
{
  "label": "Example",
  "voice": {
    "provider": "kokoro",
    "presentation": "masculine",
    "voices": { "en": "am_michael" }
  },
  "visual": { "actorId": "example" }
}
```

These are presentation defaults, not tool permissions or model routing. The
conversation owner records the chosen version and any session overrides.
Renderers may consume the visual reference without owning another conversation.

Trusted extensions receive `runtimeServices.personas.list()`, `resolve(name,
version?)`, and `publish(sourceId, definitions)`. Publish writes generated prompt
versions to PromptConfig. Identical source content is idempotent; changed source
content creates the next version and activates it. A source cannot overwrite
another source or a manually authored name. Generated entries are edited at
their source instead of through the prompt editor. Old versions remain
available to exact-version consumers. Private definitions belong in the
deployment extension, never in Product source.

No additional schema, database, persona engine or private default is installed
by Product. Workflow prompts (`agent_*`) and entries linking to an independent
application remain outside the conversation selector.
