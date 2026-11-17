---
type: added
bump: minor
---

- Generic cause queries can explicitly retain valid attention marks beside rejected
  slots, with incomplete `invalid-data` coverage. Default, native, stored, writer
  and provenance mark admission remains atomic; retained marks cannot upgrade an
  incomplete backward explanation into a supported root.
