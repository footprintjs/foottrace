---
type: fixed
bump: patch
---

Release run-envelope refusals identify the first failing predicate with a fixed `current-run-*` label. API values, paths, bodies and credentials are not included. The existing checks, order, single run lookup, job validation and fail-closed release behavior are unchanged; legacy `current-run` remains an admitted diagnostic. This reporting change does not diagnose a historical response or authorize a retry.
