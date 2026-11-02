---
type: added
bump: minor
---

Per-write traces can retain a disjoint `readAttempts` ceiling for delivered native call answers. The existing reads-prefix writer captures canonical attempt IDs independently of state paths, omits the field when empty/off, and clears it on discard. An offline host-adapter example reuses existing cause ports; recorded answer availability is conservative evidence, not proof of semantic use or external commitment.
