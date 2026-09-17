import { describe, expect, test } from "bun:test";

import {
  MIN_WORDS,
  NON_ATTEMPT_WORDS,
  assessLength,
  countWords,
  overallBand,
  roundToHalfBand,
  toCriterionBand,
} from "./ielts.ts";
import { BAND_COUNT, CRITERIA, bandsFor, descriptorFor } from "./rubric.ts";

describe("rubric", () => {
  test("every criterion carries exactly ten band levels, 0 to 9", () => {
    expect(CRITERIA).toHaveLength(4);
    for (const criterion of CRITERIA) {
      expect(criterion.bands).toHaveLength(BAND_COUNT);
      expect(criterion.bands.every((descriptor) => descriptor.length > 0)).toBe(true);
    }
  });

  test("descriptorFor returns the wording for the requested band", () => {
    expect(descriptorFor("task_response", 9)).toContain("Fully addresses all parts of the task");
    expect(descriptorFor("task_response", 0)).toContain("Does not attend");
    expect(descriptorFor("grammatical_range_accuracy", 1)).toContain("Cannot use sentence forms at all");
  });

  test("a half band maps down to the whole band achieved", () => {
    expect(descriptorFor("lexical_resource", 6.5)).toBe(descriptorFor("lexical_resource", 6));
    expect(descriptorFor("lexical_resource", 6.5)).toContain("adequate range of vocabulary");
  });

  test("descriptorFor clamps a band outside the sheet", () => {
    expect(descriptorFor("lexical_resource", 42)).toBe(descriptorFor("lexical_resource", 9));
    expect(descriptorFor("lexical_resource", -3)).toBe(descriptorFor("lexical_resource", 0));
  });

  test("levels are ordered low end first, so the band is the array index", () => {
    const bands = bandsFor("coherence_cohesion");
    expect(bands[9]).toContain("attracts no attention");
    expect(bands[7]).toContain("Logically organises");
  });
});

describe("countWords", () => {
  test("counts plain words", () => {
    expect(countWords("one two three")).toBe(3);
  });

  test("ignores surrounding punctuation and blank space", () => {
    expect(countWords("  Hello, world!  ")).toBe(2);
    expect(countWords("")).toBe(0);
    expect(countWords("   \n\t ")).toBe(0);
  });

  test("keeps contractions and hyphenated tokens as one word", () => {
    expect(countWords("don't under-estimate it")).toBe(3);
  });

  test("counts a realistic paragraph", () => {
    const paragraph = "Working from home saves commuting time, and it also widens the pool of applicants.";
    expect(countWords(paragraph)).toBe(14);
  });
});

describe("roundToHalfBand", () => {
  test("rounds to the nearest half band", () => {
    expect(roundToHalfBand(6.0)).toBe(6);
    expect(roundToHalfBand(6.24)).toBe(6);
    expect(roundToHalfBand(6.25)).toBe(6.5);
    expect(roundToHalfBand(6.4)).toBe(6.5);
    expect(roundToHalfBand(6.75)).toBe(7);
    expect(roundToHalfBand(6.9)).toBe(7);
  });

  test("clamps to the 0 to 9 grid", () => {
    expect(roundToHalfBand(-1)).toBe(0);
    expect(roundToHalfBand(12)).toBe(9);
  });
});

describe("overallBand", () => {
  test("averages the four criteria and rounds to the nearest half band", () => {
    expect(overallBand([6, 6, 6, 6])).toBe(6);
    expect(overallBand([6.5, 6.5, 6, 6])).toBe(6.5);
    expect(overallBand([6, 6, 6, 7])).toBe(6.5);
    expect(overallBand([7, 7, 7, 6])).toBe(7);
    expect(overallBand([5.5, 5.5, 6, 6])).toBe(6);
    expect(overallBand([9, 9, 9, 9])).toBe(9);
  });

  test("an empty list is band 0 rather than NaN", () => {
    expect(overallBand([])).toBe(0);
  });
});

describe("assessLength", () => {
  test("an empty response does not attend", () => {
    const result = assessLength(0);
    expect(result.status).toBe("does_not_attend");
    expect(result.note).toContain("Band 0");
  });

  test("a handful of words is not an attempt", () => {
    expect(assessLength(NON_ATTEMPT_WORDS - 1).status).toBe("does_not_attend");
  });

  test("under the minimum is flagged but still assessed", () => {
    const result = assessLength(MIN_WORDS - 40);
    expect(result.status).toBe("under_length");
    expect(result.note).toContain(String(MIN_WORDS));
  });

  test("at or over the minimum is clean", () => {
    expect(assessLength(MIN_WORDS).status).toBe("ok");
    expect(assessLength(MIN_WORDS).note).toBeNull();
  });
});

describe("toCriterionBand", () => {
  test("rounds the raw score onto the half-band grid and keeps the distribution", () => {
    const criterion = toCriterionBand("task_response", {
      score: 6.4,
      confidence: 0.72,
      probabilities: { "5": 0.05, "6": 0.5, "7": 0.45 },
    });

    expect(criterion.band).toBe(6.5);
    expect(criterion.rawScore).toBe(6.4);
    expect(criterion.name).toBe("Task Response");
    expect(criterion.descriptor).toContain("Addresses all parts of the task");
    expect(criterion.needsReview).toBe(false);
    expect(criterion.distribution).toEqual([
      { band: 5, probability: 0.05 },
      { band: 6, probability: 0.5 },
      { band: 7, probability: 0.45 },
    ]);
  });

  test("toCriterionBand pairs the achieved band with the next band up", () => {
    const criterion = toCriterionBand("lexical_resource", {
      score: 6.5,
      confidence: 0.88,
      probabilities: { "6": 0.5, "7": 0.5 },
    });
    expect(criterion.band).toBe(6.5);
    expect(criterion.descriptor).toContain("adequate range of vocabulary");
    expect(criterion.nextBand).toBe(7);
    expect(criterion.nextDescriptor).toContain("sufficient range of vocabulary");
  });

  test("band 9 has no next band", () => {
    const criterion = toCriterionBand("task_response", { score: 9, confidence: 1, probabilities: { "9": 1 } });
    expect(criterion.nextBand).toBeNull();
    expect(criterion.nextDescriptor).toBeNull();
  });

  test("a confident answer is not flagged, a split answer is", () => {
    const split = toCriterionBand("lexical_resource", {
      score: 6.5,
      confidence: 0.31,
      probabilities: { "6": 0.5, "7": 0.5 },
    });
    expect(split.needsReview).toBe(true);
  });

  test("sorting the distribution puts bands in ascending order even when keys arrive unsorted", () => {
    const criterion = toCriterionBand("coherence_cohesion", {
      score: 7,
      confidence: 0.9,
      probabilities: { "8": 0.2, "6": 0.1, "7": 0.7 },
    });
    expect(criterion.distribution.map((entry) => entry.band)).toEqual([6, 7, 8]);
  });
});