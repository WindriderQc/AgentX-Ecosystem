---
name: obsidian-open-formats
description: Create and edit Obsidian Markdown and JSON Canvas files for a user-provided vault or staging folder, with format validation and RAG-friendly authoring. Use for Obsidian notes, wikilinks, callouts, embeds, .canvas maps, or Obsidian knowledge artifacts. Do not use for Bases, Obsidian CLI or plugin development, vault synchronization, or RAG ingestion operations.
---

# Obsidian open formats

Create durable Obsidian knowledge artifacts without making the skill itself a
vault manager, synchronization tool, or ingestion authority.

## Boundaries

- Treat the user's instructions and any existing template or property schema as
  authoritative. Do not add generic frontmatter to an established collection.
- Editing a supplied file does not authorize moving, renaming, reorganizing, or
  ingesting other vault content.
- Preserve existing links, properties, block IDs, and attachment paths unless
  the requested change requires updating them.
- Never place credentials, tokens, private keys, or other secrets in a note or
  Canvas. Do not assume a hidden comment is excluded from indexing.
- Keep durable facts and source attribution in Markdown notes. Use Canvas as a
  navigational or explanatory view over those notes unless an ingestion
  contract explicitly supports `.canvas` content.

## Workflow

1. Inspect the target file and nearby conventions before editing. For a new
   artifact, confirm the requested destination or use a supplied staging
   directory.
2. Choose the format:
   - For `.md`, read [references/markdown.md](references/markdown.md) when
     Obsidian-specific syntax or RAG-friendly structure matters.
   - For `.canvas`, read
     [references/json-canvas.md](references/json-canvas.md) before creating or
     changing nodes, edges, or layout.
3. Make the smallest requested change. Essential context should remain readable
   as plain Markdown instead of existing only through transclusion.
4. Validate every changed `.md` or `.canvas` file:

   ```text
   node scripts/validate.js <file> [file...]
   ```

5. Report the files changed, validation result, and any unresolved link or
   ingestion assumption.

## Provenance

This skill is an Agent X adaptation of open Obsidian format guidance. Read
[references/sources.md](references/sources.md) when reviewing upstream drift,
licensing, or compatibility.
