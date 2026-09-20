/**
 * CLI version policy per adapter — mirrors open-design's
 * `versionPolicy.supportedVersions` (untested-version diagnostics).
 * Only encode what was actually observed: `tested` lists CLI versions this
 * library verified against (fixtures/live runs), `minimum` is a hard floor
 * with a cited reason. Absent policy means "can't judge" — never warn.
 */
export interface VersionPolicy {
  /** Hard floor, e.g. codex `"0.143.0"`. Below it → warn. */
  minimum?: string;
  /** Verified versions, e.g. `["0.150.1"]`. Older-than-all → warn; newer → ok (fail open). */
  tested?: string[];
}
