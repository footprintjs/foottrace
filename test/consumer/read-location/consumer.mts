import { STATE_PATH_SEPARATOR } from 'foottrace/paths';
import { RecordFrame, type LocatedRead, type ReadSourceOwner, type ReadSourceOccurrence } from 'foottrace/write';
// @ts-expect-error LocatedRead has no root-door type export.
import type { LocatedRead as RootLocation } from 'foottrace';
// @ts-expect-error LocatedRead has no cause-door type export.
import type { LocatedRead as CauseLocation } from 'foottrace/cause';
// @ts-expect-error LocatedRead has no paths-door type export.
import type { LocatedRead as PathsLocation } from 'foottrace/paths';
// @ts-expect-error LocatedRead has no PROV-door type export.
import type { LocatedRead as ProvLocation } from 'foottrace/prov';
// @ts-expect-error LocatedRead has no metadata-door type export.
import type { LocatedRead as MetadataLocation } from 'foottrace/metadata';
// @ts-expect-error LocatedRead has no values-door type export.
import type { LocatedRead as ValuesLocation } from 'foottrace/values';
// @ts-expect-error LocatedRead has no canonical-json-door type export.
import type { LocatedRead as JsonLocation } from 'foottrace/canonical-json';
// @ts-expect-error Internal location capture is not a public writer API.
import { beginLocatedRead } from 'foottrace/write';
// @ts-expect-error The source delegate port is internal, not a public writer type.
import type { SourceReadPort } from 'foottrace/write';

// Compiler specimen only: this function is never invoked.
function declarationChecks(frame: RecordFrame, owner: ReadSourceOwner, unknownPrivacy: unknown) {
  const keyless: LocatedRead = frame.readWithLocation([]);
  const absentKey: LocatedRead = frame.readWithLocation([], undefined);
  const plain: LocatedRead = frame.readWithLocation(['cfg'], 'n');
  const sourced: LocatedRead = frame.readWithLocation(['cfg'], 'n', owner);
  const visible: LocatedRead = frame.readWithLocation([], 'n', owner, 'visible');
  const redacted: LocatedRead = frame.readWithLocation([], 'n', owner, () => 'redacted');
  const optionalPrivacy: LocatedRead = frame.readWithLocation([], 'n', owner, undefined);
  const value: unknown = plain.value;
  const occurrence: ReadSourceOccurrence | undefined = sourced.occurrence;
  const location: readonly string[] | undefined = plain.location;
  const omitted: LocatedRead = { value: undefined, occurrence: undefined };
  const present: LocatedRead = { value: 1, occurrence: undefined, location: ['n'] };
  const optionalLocationValue: LocatedRead['location'] = undefined;
  // @ts-expect-error The holder's borrowed value slot is readonly.
  plain.value = 2;
  // @ts-expect-error The holder's source slot is readonly.
  sourced.occurrence = undefined;
  // @ts-expect-error The holder's optional location slot is readonly.
  plain.location = ['changed'];
  // @ts-expect-error Location elements are readonly.
  plain.location![0] = 'changed';
  // @ts-expect-error Location is not a mutable array.
  plain.location?.push('changed');
  // @ts-expect-error Exact optional properties forbid an own undefined location field.
  const explicitUndefined: LocatedRead = { value: 1, occurrence: undefined, location: undefined };
  // @ts-expect-error The occurrence field is present even when capture is absent.
  const missingOccurrence: LocatedRead = { value: 1 };
  // @ts-expect-error A borrowed unknown cannot be asserted to be a number by this API.
  const assumedNumber: number = plain.value;
  // @ts-expect-error Source mode requires a real owner argument.
  frame.readWithLocation([], 'n', undefined);
  // @ts-expect-error A source-mode key is required, unlike the no-source overload.
  frame.readWithLocation([], undefined, owner);
  // @ts-expect-error Falsy owners do not satisfy the public owner contract.
  frame.readWithLocation([], 'n', false);
  // @ts-expect-error Privacy is a closed synchronous verdict, not unknown.
  frame.readWithLocation([], 'n', owner, unknownPrivacy);
  // @ts-expect-error No additional privacy string is accepted.
  frame.readWithLocation([], 'n', owner, 'hidden');
  // @ts-expect-error A privacy callback cannot produce another verdict.
  frame.readWithLocation([], 'n', owner, () => 'hidden');
  // @ts-expect-error Privacy is synchronous, not a Promise-producing callback.
  frame.readWithLocation([], 'n', owner, async () => 'visible' as const);
  // @ts-expect-error LocatedRead is a type-only public export.
  void LocatedRead;
  void [
    keyless,
    absentKey,
    visible,
    redacted,
    optionalPrivacy,
    value,
    occurrence,
    location,
    omitted,
    present,
    optionalLocationValue,
    explicitUndefined,
    missingOccurrence,
    assumedNumber,
  ];
}
void declarationChecks;

const publishedSeparator: '\u001f' = STATE_PATH_SEPARATOR;
void publishedSeparator;
