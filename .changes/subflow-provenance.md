---
type: added
bump: minor
---

- Add bounded input/output subflow observations to cause record graphs, retaining exact native mount, log, write and source-cutoff identities. Known untraced child seeds now report a scope boundary. Observed-prefix links remain conservative; native inventories stay partial and whole-scope fan-out collections are not traversed. Local commit logs and standalone scope semantics remain unchanged.
