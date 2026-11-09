export * from "./types.js";
export * from "./paths.js";
export { autopilotMain, type AutopilotCliContext } from "./cli.js";
export * from "./registry.js";
export * from "./rules.js";
export * from "./lints.js";
export * from "./policy.js";
export * from "./decide.js";
export * from "./fix.js";
export * from "./verify.js";
export * from "./loop.js";
export * from "./ratchet.js";
export * from "./diff.js";
export * from "./clean.js";
export { parseSites, loadSites, selectSites, siteIdFromUrl } from "./sites.js";
export { createPortPool } from "./ports.js";
export { normaliseMessage, messageHash, signatureOf } from "./signature.js";
export {
  collectCycle,
  readMirrorRun,
  readSummaries,
  readMatrix,
  processIssues,
  replayMissIssues,
  type CollectedFinding,
  type MirrorRunDigest,
} from "./collect.js";
export { inspectCycle, type InspectResult } from "./inspect.js";
export {
  writeReports,
  buildCycleReport,
  diffCycles,
  reportIndex,
  renderCycleMarkdown,
  renderSiteMarkdown,
  type CycleReport,
  type SiteReport,
  type CycleDiff,
  type GateFlip,
} from "./report.js";
export { autopilotStatus, latestCycle, readLoopState, type StatusReport } from "./status.js";
export {
  runMatrix,
  matrixVerdict,
  stageBudgetMs,
  STAGE_DEPS,
  writeProjectConfig,
  openSnapshotReplay,
  type RunMatrixOptions,
  type OpenedReplay,
  type MatrixVerdict,
} from "./runner.js";
export {
  createFreezeStage,
  freezeStage,
  isSnapshotFresh,
  snapshotAgeDays,
  currentSnapshotDir,
  readSnapshotRef,
  type FreezeOptions,
  type ReplayFile,
} from "./stages/freeze.js";
export { createMirrorStage, mirrorStage, type MirrorStageOptions } from "./stages/mirror.js";
export { coreGoals, cliLanes } from "./cli-loop.js";
export {
  buildDesignSystem,
  generateWorkspace,
  type DsBuildOptions,
  type DsBuildResult,
  type Framework,
  type DsReport,
} from "./ds-build.js";
export { createDesignSystemStage, designSystemStage } from "./stages/design-system.js";
export { createReplicaStage, replicaStage, swapCandidates } from "./stages/replica.js";
export {
  createFinalStage,
  finalStage,
  gatesFromVerify,
  sweepIssues,
  type FinalMeasured,
} from "./stages/final.js";
export {
  COVERAGE_PROBE_JS,
  summariseCoverage,
  type CoverageResult,
  type CoverageSample,
} from "./coverage.js";
export { decideSwaps, revertIssues, swapsSource, type SwapDecision, type SwapUsage } from "./swap.js";
export { replicaFiles, REPLICA_DEPS, type ReplicaNames } from "./replica-app.js";
