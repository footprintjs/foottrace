# Change fragments

Each user-visible change adds one uniquely named lowercase `.md` file here. Use exactly:

```md
---
type: fixed
bump: patch
---

- Describe the resulting behavior and relevant limits.
```

Types: added, changed, deprecated, removed, fixed, security, documentation. Bumps: patch, minor, major. Unknown or duplicate fields, inherited object names and empty notes are refused. The strongest selected bump wins. Do not edit historical CHANGELOG sections or manually bump package versions. The Release App opens a separately reviewed release proposal, preserving every selected note and the old changelog suffix. See [release process](../docs/RELEASING.md).

Types and bumps are explicit declarations. Types do not imply a bump, and the helper does not infer breaking behavior or migration guidance from prose. A reviewer must check the chosen bump and any required migration notes; semantic inference would need a separately reviewed contract.
