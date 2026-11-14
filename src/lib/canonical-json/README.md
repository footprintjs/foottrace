# Strict canonical JSON

Public canonical JSON policy and RFC 8785 serialization, exposed only by
`foottrace/canonical-json`. It has no crypto, PROV or engine dependency. The
private shared `../owned-json/` core also serves observation data admission;
readers do not depend on this optional public capability.

`../owned-json/admit.ts` copies data descriptors into owned frozen JSON. It refuses accessors,
unsupported own members/instances, holes, cycles and lone surrogates without
calling getters, coercion or `toJSON`. Shared acyclic objects are copied and
charged on every occurrence. Callers are never frozen. Plain objects from this
realm and null-prototype objects are supported; cross-realm prototypes are not.

`canonical.ts` validates public options and translates failures into the existing
fixed `CanonicalJsonError`. Its shared `../owned-json/snapshot.ts` emits sorted raw UTF-16 names directly, including integer-like
names. Arrays and Unicode spelling stay ordered and unchanged. Numbers use
ECMAScript serialization, including -0 -> 0. The input is already parsed JS:
raw duplicate names and precision lost during parsing cannot be recovered.

`limits.ts` owns finite defaults/ceilings. Depth, expanded nodes, fields, total
raw key/string UTF-8 bytes, an upper bound on sort comparison work, and canonical
UTF-8 output are charged separately. Reflection must enumerate own keys before
its count is known. Proxy traps can execute; exceptions are fixed refusals, but a
trap that never returns needs host isolation. No partial text is returned.

Adjacent tests cover RFC ordering/number examples and strict admission. This is
not a redactor, sanitizer, signature or certification. Agentfootprint's historical
`afp-cjson/1` has different bytes and is deliberately not replaced by this utility.

```ts
canonicalizeJson({ '2': 2, '10': 10 }); // '{"10":10,"2":2}'
```
