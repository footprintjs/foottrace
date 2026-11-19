# Native capture coverage

This reader admits one producer observation for one live record segment.
`decode.ts` binds the closed v3 shape to the scope address, independently
supplied leg, boundary and segment, and the positions present in the admitted
log. `legacy.ts` owns the root-only v1/v2 vocabulary and downgrades. Missing,
malformed and newer notes leave ordinary read and writer evidence available.
The facade answers coverage without changing either the graph's edges or its
existing gaps.

Only a completed, local segment with a sufficient reported mode can cover a
question. A parent note cannot cover a child, and a worker or transport
crossing always returns a gap. A saved log requires independent storage
evidence, which this reader does not admit. It therefore reports unknown for
saved scopes even when the same note would be admitted in a live scope.

The host supplies `captureWitness` and its full log address from the actual
served record. The reader matches that address to the scope before reading the
note. Copying the witness from `capture` gives the note its own authority. The
interval is in native commit indices, not positions in a filtered application
array. A covered answer licenses a negative claim only after the caller has searched that
channel and found no matching observation. It does not establish that any
recorded access caused a value or that the window contains no observations.
