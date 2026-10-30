---
type: added
bump: minor
---

- Opt-in `explain(..., { includeBackward: true })` returns a `backward` evidence result and the `/cause` `BackwardResult` type. It exposes the existing admitted reverse walk, including dependent-to-parent edges with their attribution and evidence, plus independent backward confidence and gaps. No extra traversal or graph calls occur; omitted/false keeps existing result bytes and call order.
