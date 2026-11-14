/** Opt-in bounded content-addressed record values. Does not change live state or old record formats. */
export { createValueTable } from './lib/values/writer.js';
export { readValueRecord, readValueTable } from './lib/values/reader.js';
export { VALUE_TABLE_DEFAULTS, VALUE_TABLE_CEILINGS } from './lib/values/limits.js';
export {
  VALUE_TABLE_FORMAT,
  VALUE_RECORD_FORMAT,
  VALUE_OMISSION_REASONS,
  ValueTableError,
} from './lib/values/types.js';
export type {
  ValueReference,
  ValueTableEntry,
  ValueTableSnapshot,
  ValueRecord,
  ValueTableLimits,
  ValueTableOptions,
  ValueOmissionReason,
  ValueWriteResult,
  ValueTableWriter,
  ValueTableReader,
  OpenValueRecord,
  ValueTableErrorCode,
} from './lib/values/types.js';
