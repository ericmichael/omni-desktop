---
name: summarize-page
description: Read a page (markdown or notebook) and produce a tight summary — 3 bullets of substance plus any open questions called out.
version: 0.1.0
author: Omni Seed
---

# Summarize Page

Given a page title or ID, read the page content and produce:

1. **One-sentence gist.** The thing a reader should walk away with.
2. **Three bullets of substance.** Specific, not generic.
3. **Open questions.** If the page contains unresolved questions (TODOs, "?", "open"), list them verbatim.

## Style

- Quote sparingly. Summary is not a copy-paste.
- Preserve proper nouns, file paths, and specific numbers.
- Don't editorialize; if the page is thin, say "the page is a stub" rather than padding.

## When not to use

If the page is a notebook (`.py`), just describe what cells it contains and what the outputs are. Don't try to re-run them.
