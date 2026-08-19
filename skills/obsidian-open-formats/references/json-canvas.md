# JSON Canvas

JSON Canvas 1.0 stores an infinite-canvas view in a `.canvas` JSON file. The
top-level object contains optional `nodes` and `edges` arrays.

## Nodes

Every node has a unique string `id`, a `type`, integer `x` and `y` coordinates,
and positive integer `width` and `height` values.

| Type | Additional required field | Purpose |
|---|---|---|
| `text` | `text` | Markdown text shown directly on the Canvas |
| `file` | `file` | Vault-relative path to a note or attachment |
| `link` | `url` | External URL |
| `group` | none | Visual container; may have `label` or `background` |

Example:

```json
{
  "nodes": [
    {
      "id": "question",
      "type": "text",
      "x": 0,
      "y": 0,
      "width": 320,
      "height": 140,
      "text": "# Question\n\nHow should retrieval use the vault?"
    },
    {
      "id": "decision-note",
      "type": "file",
      "x": 440,
      "y": 0,
      "width": 360,
      "height": 240,
      "file": "Decisions/Retrieval boundary.md",
      "subpath": "#Decision"
    }
  ],
  "edges": [
    {
      "id": "question-to-decision",
      "fromNode": "question",
      "fromSide": "right",
      "toNode": "decision-note",
      "toSide": "left",
      "toEnd": "arrow",
      "label": "resolved by"
    }
  ]
}
```

## Edges and layout

- Each edge needs a unique `id`, `fromNode`, and `toNode`.
- `fromNode` and `toNode` must reference existing node IDs.
- Optional sides are `top`, `right`, `bottom`, or `left`; optional ends are
  `none` or `arrow`.
- Array order is z-order: later nodes appear above earlier nodes.
- Use consistent spacing and align related nodes. Avoid moving unrelated
  existing nodes during a focused edit.

## Knowledge and RAG boundary

Use a Canvas to express relationships, paths, and competing ideas. Put durable
claims, evidence, decisions, and citations in linked Markdown notes. This keeps
the graph useful even when the RAG policy ingests `.md` and `.txt` but not
`.canvas` files.

Do not duplicate a large note into text nodes merely to make a Canvas
self-contained. A short orientation plus file nodes normally gives a clearer
view and one durable source of truth.

## Verification

Run `node scripts/validate.js <file.canvas>` after every change. The validator
checks JSON structure, required node fields, unique IDs, allowed enum values,
and edge references. When Obsidian is available, visually inspect the Canvas for
overlap and readable edge routing.
