import getTimelineState from "./getTimelineState.js";
import identifySegments from "./identifySegments.js";
import trimClip from "./trimClip.js";
import removeGaps from "./removeGaps.js";
import removeSilences from "./removeSilences.js";
import analyzeAudioLevels from "./analyzeAudioLevels.js";
import removeSilencesByLevel from "./removeSilencesByLevel.js";
import runScript from "./runScript.js";
import getRetakeSegments from "./getRetakeSegments.js";
import markRetakes from "./markRetakes.js";
import applyRetakes from "./applyRetakes.js";

// Order here is the order tools are advertised to the agent.
export const tools = [
  getTimelineState,
  identifySegments,
  trimClip,
  removeGaps,
  removeSilences,
  // Loudness-based silence removal (Remove Silences panel + "Suggest threshold"):
  analyzeAudioLevels,
  removeSilencesByLevel,
  // Retake / duplicate removal — Claude does the analysis itself:
  getRetakeSegments,
  markRetakes,
  applyRetakes,
  runScript,
];

export const toolsByName = new Map(tools.map((t) => [t.name, t]));
