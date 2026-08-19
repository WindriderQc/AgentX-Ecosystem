# Obsidian Markdown

Use standard Markdown for ordinary structure. Add Obsidian-specific syntax only
when it improves navigation or presentation in a vault.

## Properties

Frontmatter is optional. Preserve the collection's existing schema and value
types. For a new standalone note with no supplied convention, use only the
properties that have a concrete purpose, such as `title`, `tags`, `source`, or
`updated`.

```yaml
---
title: Retrieval design
tags:
  - agentx
  - rag
source: https://example.com/source
updated: 2026-08-19
---
```

Do not silently convert dates, booleans, lists, or links into strings. Do not
replace repository-specific governance metadata with generic Obsidian
properties.

## Internal links and embeds

Use wikilinks for vault-local targets and ordinary Markdown links for external
URLs.

```markdown
[[Memory architecture]]
[[Memory architecture#Retrieval]]
[[Memory architecture|the retrieval design]]
[[Memory architecture#^decision-1]]

![[Architecture.canvas]]
![[Source note#Evidence]]
![[diagram.png|600]]
```

Add a stable block ID only when another note needs to target that block:

```markdown
The vault remains a knowledge surface, not operational task truth. ^decision-1
```

## Callouts

Use callouts for meaning, not decoration.

```markdown
> [!warning] Retrieval boundary
> Only the approved corpus is eligible for ingestion.

> [!quote] Evidence
> The claim is supported by [[Source note#Evidence]].
```

Standard types such as `note`, `info`, `tip`, `warning`, `example`, `question`,
`success`, `failure`, and `quote` are portable across ordinary Obsidian setups.

## RAG-friendly notes

- Put the note's essential claim and context in its own Markdown body. A raw
  indexer may see `![[Other note]]` without expanding the embedded content.
- Keep source URLs or source-note links beside the claims they support.
- Distinguish current facts from proposals, historical facts, and personal
  interpretation.
- Prefer descriptive headings and compact sections; they form better retrieval
  chunks than one long unstructured note.
- Do not hide important provenance in `%% comments %%`. Indexers may include or
  omit comments depending on their parser.
- A note being valid Obsidian Markdown does not make it approved for ingestion.

## Verification

After editing, check that wikilink targets and attachment paths are intentional.
When Obsidian is available, open the note in reading view for a rendering check;
this is additional verification, not permission to mutate other vault files.
