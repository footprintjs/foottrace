/** One bounded port for native subflow observations; commit logs remain local. */
export { prepareRecordSubflows } from './recordSubflows/admission.js';
export { nativeParentOf, isNativeChild } from './recordSubflows/identity.js';
export type {
  PreparedRecordSubflows,
  RecordFanoutCollection,
  RecordFanoutLimitation,
  RecordHandoffWrite,
  RecordInputHandoff,
  RecordInputLimitation,
  RecordOutputHandoff,
  RecordOutputLimitation,
  RecordSubflowMount,
  RecordSubflows,
} from './recordSubflows/types.js';
