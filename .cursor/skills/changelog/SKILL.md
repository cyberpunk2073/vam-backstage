---
name: changelog
description: Write in-app release notes for a new app version. Use when asked to create or update the changelog, release notes, or "What's new" entries, or to summarize changes since a release tag.
---

# Writing Changelogs

Read changelog.js file first for the data shape and voice. Releases are tagged `vX.Y.Z`; find latest one, and the commit range since then - that's our changes. Use subagents to read commit diffs, group related changes into batches for a single subagent.

## Style

Every note describes what changed in the user's experience - not what the developer did, what code changed, or a list of commits. Wording simple and concrete enough for a non-technical user, engaging but not marketing-y.

- Don't map commits 1:1 to notes. Merge related work, judge what's actually notable, cut the rest.
- Each notable change gets its own note: benefit-focused title, 1-2 sentence body on what the user will notice.
- Minor ones aggregate into "Many small improvements" (`improved`) and "Many small fixes" (`fixed`), one sentence of highlights each. Refactors, tests, deps are invisible to the user - omit them.
- Order notes by importance.

## BBcode

After work on the changelog is approved by developer, generate the BBcode release notes, post into code block in the chat

```
[*][B]Feature title:[/B] Feature description
```
