---
type: fixed
bump: patch
---

- Run evidence: the writer no longer stores `about` content its own reader refuses. A read name with a control character is left out and counted in `readsOmitted`; an `about` whose `parent` or `resumes` is not a runtimeStageId is dropped and counted. Before this the reader refused the whole `about` and its parent link was lost. An id longer than the `text` cap now reads `truncated`, not `invalid-data`. `RunControl.why` and `EvidenceChannel.why` are typed as a union of the nine reasons the code returns, `unknown-execution` among them.
- PROV export: each read is charged for its own lookup, not for the whole index, so a record of a thousand commits keeps its `ft:Read` evidence under the `maxWork` ceiling. Output bytes are no longer also charged as work: the default `maxWork` used to stop an export near 240 KB, below the default `maxOutputBytes`. "export output limit reached" is reported only when the byte ceiling refused a node. A mark carried by both the attention map and the execution tree is one `ft:Attention` node.
- Cause: a source identity past the ID ceiling is reported as `invalid-data` and the remaining source edges are kept. It was reported as `edge-limit`, and the remaining edges were dropped.
