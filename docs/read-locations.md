# Native read locations

`RecordFrame.readWithLocation` on `foottrace/write` returns the original borrowed
value together with optional, owned literal location segments:

```ts
import { RecordFrame, SharedMemory, type LocatedRead } from 'foottrace/write';

const state = new SharedMemory(undefined, { settings: { timeoutMs: 500 } });
const frame = new RecordFrame(state);
const read: LocatedRead = frame.readWithLocation(['settings'], 'timeoutMs');
// read.value === 500; read.location is ['settings', 'timeoutMs']
```

The frozen holder always has `value` and `occurrence`; `location` is an optional
own property, not an `undefined` placeholder. Only the holder and its copied
string array are frozen. The returned value, state and caller arrays retain
their existing ownership. Reading does not automatically enable canonical read
tracking, source capture or storage of locations.

The native traversal supplies segments while selecting the value, including its
actual namespace or root fallback. A literal `a.b` key is `['a.b']`; nested
`a` then `b` is `['a', 'b']`. Slashes, U+001F, empty-string keys and string array
indices retain their literal spelling. A keyed container names that container,
not a claim that its members were read. The receipt is independent of later
caller-array mutation and reentrant reads; it contains no live frame handle.

## Source mode and privacy

The overload with a third `ReadSourceOwner` argument uses the same source
transaction as `readWithSource`. The optional fourth verdict runs once after
the read, even when source capture is absent, with its existing error behavior:

```ts
const withheld = frame.readWithLocation(
  ['settings'], 'timeoutMs', { runtimeStageId: 'read#0' }, () => 'redacted',
);
// Original value semantics; no location. Source occurrence follows existing capture rules.
```

Omitting the third argument does not start a source transaction or invoke a
privacy callback. Source mode is selected by argument presence, not owner
truthiness; callers must provide a valid owner. Its nonvisible verdict omits
the new metadata without a second verdict. `occurrence` keeps its existing
root/composite coverage semantics; precise segments do not upgrade it.

## Bounds, omissions and evidence

One location has at most 64 total segments including the winning namespace,
1024 UTF-16 code units per segment and 4096 units in total. Overflow omits the
whole location, never truncates it or changes the data read. Bounds apply to
the actual winning candidate, not a losing namespace prefix.

Keyless, undefined, failed, accessor-observed, unsupported-selector and
nonvisible reads omit location. Existing canonical getter and staged-undefined
prefixes are still recorded under their existing tracking rules. The new
metadata cannot recover silent/raw reads, listings or a custom port that did
not complete a native traversal. Original read and verdict exceptions propagate
without retry or inspection. Active observation tokens are forgotten in
`finally`; no last-read field or history bank is retained.

These are structural selection facts, not semantic use, complete read coverage,
reference authentication or privacy history. Existing native Proxy/accessor
execution remains host code; location admission is not a sandbox. A later
engine recorder adapter must apply its own reviewed event-time privacy contract.
Absence of a location is unknown and cannot prove an input was never read.

Migration: this is an additive explicit read entry. Existing `read`,
`readTracked`, `readWithSource`, source records and tracking defaults retain
their contracts. Consumers need an actual feature-bearing published version;
an unreleased source-built archive does not establish registry availability or
an engine's required peer-version floor.
