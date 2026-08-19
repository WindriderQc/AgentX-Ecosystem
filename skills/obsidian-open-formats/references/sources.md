# Sources and compatibility

The format guidance is derived from these public sources:

- Obsidian Skills by Steph Ango, MIT License, reviewed at commit
  `a1dc48e68138490d522c04cbf5822214c6eb1202`:
  <https://github.com/kepano/obsidian-skills>
- Obsidian Flavored Markdown:
  <https://help.obsidian.md/obsidian-flavored-markdown>
- JSON Canvas 1.0 specification:
  <https://jsoncanvas.org/spec/1.0/>

The Agent X adaptation intentionally excludes Obsidian CLI, Bases, plugin
development, synchronization, and automatic RAG ingestion. Those capabilities
have different compatibility and mutation risks and should be reviewed as
separate skills.

When updating this skill, treat the official format documentation as the
syntax authority. Record the reviewed upstream commit and verify the included
validator against representative valid and invalid artifacts before accepting
the update.
