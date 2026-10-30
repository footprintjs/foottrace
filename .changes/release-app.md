---
type: changed
bump: patch
---

- Prepare separately reviewed releases through a repository-scoped Release App. Publication requires exact-head approval, both CodeQL checks and the original Node 22/24 gates or a matching current-attempt CI proof. The checked archive is submitted once through npm trusted publishing; ambiguous prior attempts remain verification-only. Owner installation and trusted-publisher setup are required before use.
