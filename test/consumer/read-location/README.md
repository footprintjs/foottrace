# Packed located-read consumers

These fixtures prove the actual emitted `foottrace/write` door, without an engine,
provider, dependency install or source alias. They run after the ordinary build.
The normal package gate must retain both commands:

```sh
tsc -p test/consumer/read-location/tsconfig.json
node --test test/consumer/read-location/packed.test.cjs
```

The first command compiles the public CJS/ESM declarations with NodeNext, strict
library checking, exact optional properties and no ambient type packages or aliases.
Its uncalled function bodies exercise both overloads, readonly holder/location,
required occurrence, unknown values, explicit optional-undefined rules and refusal
of unknown/asynchronous privacy. `LocatedRead` is type-only on `/write` alone.

The runtime test packs the already built package offline with scripts disabled,
checks raw SHA1/SHA256/SHA512 integrity and original name/version, and unpacks the
real archive into a fresh consumer's `node_modules/foottrace`. It copies the strict
specimens there, verifies their actual CJS/ESM declaration resolution and compiles
them with the existing compiler, then executes both real public runtime exports.
The witnesses cover borrowed values, literal segments, frozen owned metadata,
namespace/root fallback, source privacy, old read doors, private-helper exclusion
and stable frame own keys. No package or version is replaced or relabelled.

Child processes have finite timeouts and receive command lookup/platform variables
only, not ambient startup hooks or credentials. npm uses empty task-local user/global
configuration and a disposable cache. The archive, consumer, compiler intermediates
and cache are removed in `finally`; the normal check log retains only proof metadata.

The source branch's original `2.0.0` archive can prove those bytes and exports. It
cannot meet a proposed `2.1.0` peer floor, establish engine compatibility, or imply
publication/release authorization. Read the reported actual version and hashes.
Adding this gate supplies no local build/install/full-suite grant.
