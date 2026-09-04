/**
 * "Leo" pixel presenter style package — public API.
 * From a job scene: `import { Leo, LeoCorner } from "../../../styles/leo/src";`
 * and `import words from "./words.json";` for the lip sync.
 */
export { PALETTE, SPRITE_W, SPRITE_H, type Paint, type Grid } from "./palette";
export {
  buildSprite, gridRuns, POSE_REST, VISEMES,
  type SpritePose, type Viseme, type EyeKind, type BrowKind, type HairKind, type Run,
} from "./sprite";
export {
  planSpeech, visemeAt, isSpeaking, openness, sinceOnset, inQuestion, syllables, visemeForSyllable,
  type Word, type SpeechPlan, type Segment,
} from "./lipsync";
export { hash01, isBlinking, blinkTime, breath, talkBob, idleTurn, snap } from "./motion";
export { Leo, LeoCorner, PixelPanel, LEO, pixelScale, type LeoProps, type LeoCornerProps, type Mood, type Corner } from "./Leo";
