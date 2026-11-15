# Private bounded owned JSON

One shared strict data-admission and serialization core, without public option
policy, producer logic, crypto or environment capabilities. It is not a public
package door. Capability adapters supply concrete validated bounds and translate
fixed internal refusals into their own safe errors. The snapshot boundary first
normalizes every thrown object into a fresh fixed private error using only a
known own data code; foreign code/message getters and exception identity never
reach capability adapters. The private code list also preserves canonical public
options refusals without a second vocabulary.

`admit.ts` owns data-descriptor copying, Unicode validation, occurrence charging
and freezing. `snapshot.ts` serializes that detached value with sorted raw UTF-16
names and exact byte/sort budgets. `types.ts` defines only the private domain,
concrete bounds and coded refusals. These are the existing canonical algorithms,
shared rather than duplicated; public canonical policy remains in
`../canonical-json/` and observation convention policy in `../observations/`.

`utf8.ts` owns the existing pure UTF-8 counter formerly under PROV. Its caller
must supply a well-formed string: admission validates raw strings first; JSON
serialization escapes lone surrogates in the resulting text. It needs no global
encoder and allocates no encoded byte array. This is not a measured CPU or peak
memory guarantee. Adjacent tests cover ownership, Unicode, exact budgets and
refusals; the observation cold-import tests protect optional capability doors.
