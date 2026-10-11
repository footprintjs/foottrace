# Saved-tree reader inputs

These are byte-for-byte copies of already reviewed public-producer fixtures in
`footprintjs/explainable-ui`, not regenerated recordings or invented trees.

| File | Original path and introduction | SHA-256 |
| --- | --- | --- |
| `linear-decider-9.15.1.json` | `test/fixtures/golden/linear-decider.json`, commit `fbe6eb672f8500dc276987d63d314c7236f33e73` | `79c841b760e177b34e37288bb98af4d05703da520eada8c2bc09e507d2995903` |
| `hci-3.0.0.json` | `pilots/record-lens/fixtures/hci.json`, commit `cc8e47f34440f518b1a1d69b3aeb77e532a602d4` | `fc287b4e0c4e955e2d0ec6b1145971e020e829238e0e77bdd0e39d0f614ceee8` |

The historical fixture was captured from footprintjs 9.15.1 by the original
golden-fixture generator. Its existing normalized timestamps and other fields
are retained exactly. The test reads the snapshot's stored execution tree.

The HCI fixture was recorded through hcifootprint 3.0.0's public session API with
foottrace 1.0.0. Its source checkout used footprintjs 9.48.3 for schema helpers.
It contains committed transitions and `Session.readsByStep`, not an execution
tree. The test therefore uses the existing map strategy and must not invent a
tree or coverage for it. A fifth, pending interaction is not a recorded commit.

The current Flow 10 witness is already pinned in
`../causal-phases/runtime-snapshot-10.0.0.json`; that file and the HCI 2.6.1
writer fixture remain untouched. Hash checks and before/after serialization
checks protect these inputs. No producer runtime is installed for these tests.
