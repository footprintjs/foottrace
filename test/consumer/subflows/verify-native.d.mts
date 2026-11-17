/** Types for the protocol's raw-record assertion helpers; not a package or SDK declaration. */
export function assertCaptureState(
  handoff: unknown,
  options?: { privateView?: boolean; selectorUnavailable?: boolean },
): void;
export function assertSeedBinding(mount: unknown, child: unknown): void;
export function uniqueStage(scope: unknown, fullStageId: string, reader: unknown): number;
