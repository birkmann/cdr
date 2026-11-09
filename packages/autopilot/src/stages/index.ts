import type { StageName, StageRunner } from "../types.js";
import { designSystemStage } from "./design-system.js";
import { finalStage } from "./final.js";
import { freezeStage } from "./freeze.js";
import { mirrorStage } from "./mirror.js";
import { replicaStage } from "./replica.js";

export const STAGES: Record<StageName, StageRunner> = {
  freeze: freezeStage,
  mirror: mirrorStage,
  "design-system": designSystemStage,
  replica: replicaStage,
  final: finalStage,
};
