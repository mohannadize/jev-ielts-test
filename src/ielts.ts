/**
 * Deterministic IELTS arithmetic and rules.
 *
 * Everything in this file is plain code: counting, rounding, thresholds and the
 * band lookups. None of it is a model judgment, so none of it is asked of the model.
 * Thresholds are named constants so they are visible and tunable in one place.
 */

import { CRITERIA, TOP_BAND, criterionMeta, descriptorFor, type CriterionId } from "./rubric.ts";

/** Writing Task 2 minimum length, as printed on the question paper. */
export const MIN_WORDS = 250;

/** Below this, the response is treated as "does not attend" (see band 0). */
export const NON_ATTEMPT_WORDS = 10;

/** A Score answer at or below this confidence is surfaced as needing review. */
export const LOW_CONFIDENCE = 0.5;

/** A memorised-response probability at or above this flags the response. */
export const MEMORISED_THRESHOLD = 0.8;

/** Number of tokens that look like words, ignoring pure punctuation. */
export function countWords(text: string): number {
  return text
    .split(/\s+/)
    .map((token) => token.replace(/^[^\p{L}\p{N}']+|[^\p{L}\p{N}']+$/gu, ""))
    .filter((token) => token.length > 0).length;
}

/** IELTS reports whole and half bands: round a fractional Score onto the 0.5 grid. */
export function roundToHalfBand(score: number): number {
  const clamped = Math.min(Math.max(score, 0), 9);
  return Math.round(clamped * 2) / 2;
}

/**
 * Overall band: the mean of the four criterion bands, rounded to the nearest
 * half band. An average ending in .25 rounds up to .5 and .75 rounds up to the
 * next whole band, which `roundToHalfBand` gives us.
 */
export function overallBand(bands: readonly number[]): number {
  if (bands.length === 0) return 0;
  const mean = bands.reduce((sum, band) => sum + band, 0) / bands.length;
  return roundToHalfBand(mean);
}

export type LengthStatus = "does_not_attend" | "under_length" | "ok";

export interface LengthAssessment {
  wordCount: number;
  status: LengthStatus;
  /** Candidate-facing note, or null when there is nothing to say. */
  note: string | null;
}

/** Length is a code-owned rule: it is a count, not a judgment. */
export function assessLength(wordCount: number): LengthAssessment {
  if (wordCount < NON_ATTEMPT_WORDS) {
    return {
      wordCount,
      status: "does_not_attend",
      note:
        wordCount === 0
          ? "No response was submitted. Band 0 applies: the task was not attempted."
          : `Only ${wordCount} words were submitted, which is not an attempt at the task. Band 0 applies.`,
    };
  }
  if (wordCount < MIN_WORDS) {
    return {
      wordCount,
      status: "under_length",
      note: `${wordCount} words. Task 2 requires at least ${MIN_WORDS}, so examiners would apply an under-length penalty to Task Response.`,
    };
  }
  return { wordCount, status: "ok", note: null };
}

export interface CriterionBand {
  id: CriterionId;
  name: string;
  short: string;
  /** Band awarded to the nearest half band. */
  band: number;
  /** Raw probability-weighted Score from the model, before rounding; can sit between bands. */
  rawScore: number;
  confidence: number;
  /** Probability mass per band, ascending by band. */
  distribution: { band: number; probability: number }[];
  /** Official wording for the band achieved (the whole band at or below the half band). */
  descriptor: string;
  /** Next whole band up, or null when the criterion is already at band 9. */
  nextBand: number | null;
  /** What the next band up requires, or null at band 9. */
  nextDescriptor: string | null;
  /** True when the answer's own confidence is below LOW_CONFIDENCE. */
  needsReview: boolean;
}

export interface ScoreAnswerLike {
  score: number;
  confidence: number;
  probabilities: Record<string, number>;
}

/** Convert one Score answer into the criterion result the UI explains. */
export function toCriterionBand(id: CriterionId, answer: ScoreAnswerLike): CriterionBand {
  const meta = criterionMeta(id);
  const band = roundToHalfBand(answer.score);
  const wholeBand = Math.floor(band);
  const nextBand = wholeBand < TOP_BAND ? wholeBand + 1 : null;
  const distribution = Object.entries(answer.probabilities)
    .map(([level, probability]) => ({ band: Number(level), probability }))
    .filter((entry) => Number.isFinite(entry.band))
    .sort((a, b) => a.band - b.band);

  return {
    id,
    name: meta.name,
    short: meta.short,
    band,
    rawScore: answer.score,
    confidence: answer.confidence,
    distribution,
    descriptor: descriptorFor(id, band),
    nextBand,
    nextDescriptor: nextBand === null ? null : descriptorFor(id, nextBand),
    needsReview: answer.confidence < LOW_CONFIDENCE,
  };
}

/** Criterion ids in official report order. */
export function criterionIds(): CriterionId[] {
  return CRITERIA.map((criterion) => criterion.id);
}