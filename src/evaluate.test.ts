import { describe, expect, test } from "bun:test";

import { buildQuestions, buildScoreQuestion, buildState, composeEvaluation, evaluateEssay, noAttemptResult } from "./evaluate.ts";
import { BAND_COUNT } from "./rubric.ts";
import type { Answer, SystemOneResult } from "./typesafe.ts";

/** A complete set of answers in the shape the API returns. Used to test composition. */
const FIXTURE_ANSWERS: Record<string, Answer> = {
  task_response: {
    type: "score",
    score: 6.4,
    legend: {},
    probabilities: { "5": 0.05, "6": 0.5, "7": 0.45 },
    confidence: 0.72,
  },
  coherence_cohesion: {
    type: "score",
    score: 6.0,
    legend: {},
    probabilities: { "6": 1 },
    confidence: 0.94,
  },
  lexical_resource: {
    type: "score",
    score: 6.5,
    legend: {},
    probabilities: { "6": 0.5, "7": 0.5 },
    confidence: 0.86,
  },
  grammatical_range_accuracy: {
    type: "score",
    score: 7.0,
    legend: {},
    probabilities: { "7": 1 },
    confidence: 0.9,
  },
  position_clear: { type: "noul", noul: 0.91 },
  paragraphing_adequate: { type: "noul", noul: 0.86 },
  memorised_response: { type: "noul", noul: 0.03 },
};

/** The same answers, but Lexical Resource split evenly across two bands. */
const SPLIT_ANSWERS: Record<string, Answer> = {
  ...FIXTURE_ANSWERS,
  lexical_resource: {
    type: "score",
    score: 6.5,
    legend: {},
    probabilities: { "6": 0.5, "7": 0.5 },
    confidence: 0.41,
  },
};

const FIXTURE_USAGE = { input_tokens: 1500, output_tokens: 40 };

describe("question design", () => {
  test("one request carries four criterion Scores and three Noul checks", () => {
    const questions = buildQuestions();
    expect(Object.keys(questions).sort()).toEqual([
      "coherence_cohesion",
      "grammatical_range_accuracy",
      "lexical_resource",
      "memorised_response",
      "paragraphing_adequate",
      "position_clear",
      "task_response",
    ]);
    expect(Object.values(questions).filter((question) => question.type === "score")).toHaveLength(4);
    expect(Object.values(questions).filter((question) => question.type === "noul")).toHaveLength(3);
  });

  test("each criterion Score carries the ten band descriptors in order", () => {
    const question = buildScoreQuestion("task_response");
    expect(question.type).toBe("score");
    expect(question.criteria).toHaveLength(BAND_COUNT);
    expect(question.criteria[0]).toContain("Does not attend");
    expect(question.criteria[9]).toContain("Fully addresses all parts of the task");
  });

  test("criterion questions point at the state paths and stay on one dimension", () => {
    const question = buildScoreQuestion("lexical_resource");
    const instructions = question.instructions as Record<string, unknown>;
    expect(instructions.question).toContain("`essay.response`");
    expect(instructions.inspect).toBe("`essay.response`");
    expect(String(instructions.focus)).toContain("Ignore grammar");
  });

  test("the Noul checks describe both sides of the yes/no boundary", () => {
    const questions = buildQuestions();
    const memorised = questions.memorised_response;
    expect(memorised?.type).toBe("noul");
    if (memorised?.type !== "noul") throw new Error("expected a noul");
    expect(memorised.criteria?.true).toBeDefined();
    expect(memorised.criteria?.false).toBeDefined();
  });

  test("state carries the task, the response, and the code-counted word count", () => {
    const state = buildState("Some prompt", "A four word answer", 4, 250) as {
      task: Record<string, unknown>;
      essay: Record<string, unknown>;
    };
    expect(state.task.prompt).toBe("Some prompt");
    expect(state.task.minimum_words).toBe(250);
    expect(state.essay.response).toBe("A four word answer");
    expect(state.essay.word_count).toBe(4);
  });
});

describe("composeEvaluation", () => {
  const result = composeEvaluation(FIXTURE_ANSWERS, {
    wordCount: 268,
    model: "jev-1.13.0",
    usage: FIXTURE_USAGE,
  });

  test("rounds each criterion onto the half-band grid", () => {
    expect(result.criteria.map((criterion) => criterion.band)).toEqual([6.5, 6, 6.5, 7]);
  });

  test("averages the reported bands into the overall band", () => {
    // (6.5 + 6 + 6.5 + 7) / 4 = 6.5
    expect(result.overallBand).toBe(6.5);
  });

  test("attaches the official descriptor for the awarded band", () => {
    const taskResponse = result.criteria[0];
    expect(taskResponse?.descriptor).toContain("Addresses all parts of the task");
    expect(taskResponse?.nextBand).toBe(7);
    expect(taskResponse?.nextDescriptor).toContain("clear position throughout");
    const grammar = result.criteria[3];
    expect(grammar?.descriptor).toContain("Uses a variety of complex structures");
  });

  test("reports the checks and the model that answered", () => {
    expect(result.checks.positionClear).toBe(0.91);
    expect(result.checks.memorisedResponse).toBe(0.03);
    expect(result.model).toBe("jev-1.13.0");
    expect(result.usage).toEqual(FIXTURE_USAGE);
    expect(result.judgedBy).toBe("model");
  });

  test("a full-length, distinct essay produces no warnings", () => {
    expect(result.warnings).toEqual([]);
    expect(result.needsReview).toBe(false);
    expect(result.length.status).toBe("ok");
  });

  test("flags an under-length essay", () => {
    const short = composeEvaluation(FIXTURE_ANSWERS, { wordCount: 180, model: "jev-1.13.0", usage: null });
    expect(short.length.status).toBe("under_length");
    expect(short.warnings.join(" ")).toContain("under-length penalty");
    expect(short.needsReview).toBe(true);
  });

  test("flags a memorised response", () => {
    const memorised = composeEvaluation(
      { ...FIXTURE_ANSWERS, memorised_response: { type: "noul", noul: 0.93 } },
      { wordCount: 268, model: "jev-1.13.0", usage: null },
    );
    expect(memorised.warnings.join(" ")).toContain("memorised");
    expect(memorised.needsReview).toBe(true);
  });

  test("flags the low-confidence criterion, and only that one", () => {
    const split = composeEvaluation(SPLIT_ANSWERS, { wordCount: 268, model: "jev-1.13.0", usage: null });
    const lowConfidence = split.criteria.filter((criterion) => criterion.needsReview);
    expect(lowConfidence.map((criterion) => criterion.short)).toEqual(["LR"]);
    expect(split.warnings.join(" ")).toContain("Low confidence");
    expect(split.overallBand).toBe(6.5);
  });

  test("is deterministic for the same answers", () => {
    const again = composeEvaluation(FIXTURE_ANSWERS, { wordCount: 268, model: "jev-1.13.0", usage: FIXTURE_USAGE });
    expect(again).toEqual(result);
  });

  test("an answer missing a criterion fails loudly instead of reporting a guess", () => {
    const { task_response: _dropped, ...incomplete } = FIXTURE_ANSWERS;
    expect(() => composeEvaluation(incomplete, { wordCount: 268, model: "jev-1.13.0", usage: null })).toThrow(
      /no answer for "task_response"/,
    );
  });
});

describe("noAttemptResult", () => {
  test("is band 0 everywhere, decided by code rather than a model call", () => {
    const result = noAttemptResult(0);
    expect(result.overallBand).toBe(0);
    expect(result.criteria.every((criterion) => criterion.band === 0)).toBe(true);
    expect(result.judgedBy).toBe("code");
    expect(result.usage).toBeNull();
    expect(result.warnings.join(" ")).toContain("Band 0");
  });
});

describe("evaluateEssay", () => {
  test("does not call the API when there is no attempt", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const result = await evaluateEssay({
      prompt: "Some prompt",
      response: "   ",
      apiKey: "test-key",
      deps: { fetchImpl, sleep: async () => {} },
    });

    expect(calls).toBe(0);
    expect(result.judgedBy).toBe("code");
    expect(result.overallBand).toBe(0);
  });

  test("sends one request whose state and questions match the design", async () => {
    const essay = "Remote work saves the commute. ".repeat(30).trim();
    let sentBody: Record<string, unknown> | undefined;

    const fetchImpl = (async (_input: Request | string | URL, init?: RequestInit) => {
      sentBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ model: "jev-1.13.0", answers: FIXTURE_ANSWERS, usage: FIXTURE_USAGE }), {
        status: 200,
      });
    }) as unknown as typeof fetch;

    const result = await evaluateEssay({
      prompt: "Discuss both views and give your own opinion.",
      response: essay,
      apiKey: "test-key",
      deps: { fetchImpl, sleep: async () => {} },
    });

    expect(sentBody?.model).toBe("jev-latest");
    expect(Object.keys(sentBody?.questions as object)).toHaveLength(7);
    const state = sentBody?.state as { essay: { word_count: number; response: string }; task: { prompt: string } };
    expect(state.essay.response).toBe(essay);
    expect(state.essay.word_count).toBe(150);
    expect(state.task.prompt).toContain("Discuss both views");
    expect(result.overallBand).toBe(6.5);
  });

  test("surfaces an upstream failure as a TypeSafeError", async () => {
    const fetchImpl = (async () => new Response("{}", { status: 401 })) as unknown as typeof fetch;
    const failure = await evaluateEssay({
      prompt: "Some prompt",
      response: "A long enough answer to reach the model. ".repeat(20),
      apiKey: "bad-key",
      deps: { fetchImpl, sleep: async () => {}, maxAttempts: 1 },
    }).catch((error: unknown) => error);

    expect((failure as Error).name).toBe("TypeSafeError");
    expect((failure as { status: number }).status).toBe(401);
  });
});

describe("result shape", () => {
  test("a composed result serialises cleanly, which is what /api/evaluate returns", () => {
    const result = composeEvaluation(FIXTURE_ANSWERS, { wordCount: 268, model: "jev-1.13.0", usage: FIXTURE_USAGE });
    const roundTripped = JSON.parse(JSON.stringify(result)) as SystemOneResult & typeof result;
    expect(roundTripped.overallBand).toBe(6.5);
    expect(roundTripped.criteria).toHaveLength(4);
  });
});