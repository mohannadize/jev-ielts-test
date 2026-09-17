/**
 * The evaluation workflow.
 *
 * Code owns the workflow: it counts words, builds the state and the questions,
 * makes one TypeSafe call, then composes the answers into a band report. The model
 * is asked four Score questions (one per IELTS criterion) plus three Noul checks,
 * all against the same state, in a single request.
 *
 * Question design notes:
 * - One narrow judgment per question, so a low answer on one criterion cannot
 *   bleed into another.
 * - Levels are the official band descriptors, low end first, index = band.
 * - Each Score question is asked over the same state, so they run in parallel and
 *   cannot see each other's answers; composition happens here in code.
 * - Length and rounding are counted, not judged.
 */

import {
  LOW_CONFIDENCE,
  MEMORISED_THRESHOLD,
  NON_ATTEMPT_WORDS,
  assessLength,
  countWords,
  overallBand,
  toCriterionBand,
  type CriterionBand,
  type LengthAssessment,
} from "./ielts.ts";
import { CRITERIA, bandsFor, type CriterionId } from "./rubric.ts";
import {
  DEFAULT_MODEL,
  askSystemOne,
  readNoul,
  readScore,
  type ClientDeps,
  type NoulQuestion,
  type Question,
  type ScoreQuestion,
  type SystemOneResult,
  type Usage,
} from "./typesafe.ts";

/** The four criterion Scores plus the three Noul checks, in one request. */
export const SCORE_IDS: readonly CriterionId[] = CRITERIA.map((criterion) => criterion.id);
export const NOUL_IDS = ["position_clear", "paragraphing_adequate", "memorised_response"] as const;
export type NoulId = (typeof NOUL_IDS)[number];

/** Focus text keeps each criterion question to one dimension. */
const CRITERION_FOCUS: Record<CriterionId, { question: string; focus: string }> = {
  task_response: {
    question:
      "How well does `essay.response` meet the Task Response band descriptors for the essay task set in `task.prompt`?",
    focus:
      "Judge only how the essay responds to the task: whether it addresses all parts of the question, whether it presents a clear and consistent position, and whether the main ideas are developed and supported. Ignore vocabulary, grammar and cohesion; other questions cover those.",
  },
  coherence_cohesion: {
    question:
      "How well does `essay.response` meet the Coherence and Cohesion band descriptors for an IELTS Writing Task 2 essay?",
    focus:
      "Judge only organisation and flow: logical sequencing of information and ideas, overall progression, use of cohesive devices, referencing and substitution, and paragraphing. Ignore vocabulary, grammar, and how well the ideas answer the task; other questions cover those.",
  },
  lexical_resource: {
    question:
      "How well does `essay.response` meet the Lexical Resource band descriptors for an IELTS Writing Task 2 essay?",
    focus:
      "Judge only vocabulary: range, flexibility and precision, use of less common lexical items, awareness of style and collocation, and errors in spelling or word formation. Ignore grammar and organisation; other questions cover those.",
  },
  grammatical_range_accuracy: {
    question:
      "How well does `essay.response` meet the Grammatical Range and Accuracy band descriptors for an IELTS Writing Task 2 essay?",
    focus:
      "Judge only grammar and punctuation: range and variety of structures, complexity, the proportion of error-free sentences, and control of punctuation. Ignore vocabulary and organisation; other questions cover those.",
  },
};

const NOUL_QUESTIONS: Record<NoulId, NoulQuestion> = {
  position_clear: {
    type: "noul",
    instructions: {
      question:
        "Does `essay.response` express a clear position on the question in `task.prompt` and maintain it through the essay?",
      inspect: "`essay.response`",
      compare: ["`essay.response`", "`task.prompt`"],
      focus:
        "Require a stance a reader could state after reading the essay, held from introduction to conclusion. An essay that never commits to a view is not clear, even if it is well written.",
    },
    criteria: {
      true: {
        what: "States a position on the question and does not reverse or abandon it",
        examples: ["The introduction states the writer's view and the conclusion restates the same view"],
      },
      false: {
        what: "No identifiable position, or a position that shifts or is contradicted later",
        examples: [
          "The essay only lists arguments for both sides and never says which the writer favours",
          "The conclusion argues the opposite of the introduction",
        ],
      },
    },
  },
  paragraphing_adequate: {
    type: "noul",
    instructions: {
      question: "Does `essay.response` use paragraphs to separate distinct ideas?",
      inspect: "`essay.response`",
      focus:
        "Judge whether distinct ideas sit in separate paragraphs and whether each paragraph develops one central topic. Do not judge vocabulary, grammar or the quality of the ideas.",
    },
    criteria: {
      true: {
        what: "Distinct ideas are separated into paragraphs, each developing one central topic",
        examples: ["An introduction, one paragraph per main idea, and a conclusion"],
      },
      false: {
        what: "One undivided block of text, or paragraph breaks that do not follow the ideas",
        examples: ["The whole essay is a single paragraph", "A new paragraph starts mid-sentence or every second line"],
      },
    },
  },
  memorised_response: {
    type: "noul",
    instructions: {
      question:
        "Is `essay.response` a memorised or template response rather than an answer written for the specific task in `task.prompt`?",
      inspect: "`essay.response`",
      compare: ["`essay.response`", "`task.prompt`"],
      focus:
        "Look for prepared text that ignores the specific question, generic filler that would fit any prompt, or memorised chunks that do not fit this topic. A conventional four-paragraph structure is not on its own a memorised response.",
    },
    criteria: {
      true: {
        what: "Prepared or template text that does not answer this specific question",
        examples: [
          "An essay about the environment pasted in answer to a question about education",
          "Fluent generic sentences that never refer to the question's specific topic",
        ],
      },
      false: {
        what: "Text written in response to this question, even if its structure is formulaic",
        not_for: "A conventional essay that still addresses the specific question",
      },
    },
  },
};

/** Structured state: the task and the response, with only what the questions need. */
export function buildState(prompt: string, response: string, wordCount: number, minimumWords: number) {
  return {
    task: {
      exam: "IELTS Academic and General Training",
      paper: "Writing Task 2",
      prompt,
      minimum_words: minimumWords,
    },
    essay: {
      response,
      word_count: wordCount,
    },
  };
}

export function buildScoreQuestion(id: CriterionId): ScoreQuestion {
  const config = CRITERION_FOCUS[id];
  return {
    type: "score",
    instructions: {
      question: config.question,
      inspect: "`essay.response`",
      compare: ["`essay.response`", "`task.prompt`"],
      focus: config.focus,
      note: "The levels are the official IELTS public-version band descriptors for this criterion, ordered from band 0 to band 9. Judge the essay as a whole against each level and pick the one it matches most closely.",
    },
    criteria: bandsFor(id),
  };
}

/** All seven questions for one request. */
export function buildQuestions(): Record<string, Question> {
  const questions: Record<string, Question> = {};
  for (const id of SCORE_IDS) questions[id] = buildScoreQuestion(id);
  for (const id of NOUL_IDS) questions[id] = NOUL_QUESTIONS[id];
  return questions;
}

export interface EvaluationChecks {
  positionClear: number | null;
  paragraphingAdequate: number | null;
  memorisedResponse: number | null;
}

export interface EvaluationResult {
  /** Overall band, rounded to the nearest half band. */
  overallBand: number;
  criteria: CriterionBand[];
  checks: EvaluationChecks;
  length: LengthAssessment;
  /** True when any judgment was too uncertain to report without review. */
  needsReview: boolean;
  warnings: string[];
  model: string;
  usage: Usage | null;
  /** "model" when the model answered; "code" when a code rule settled it without a call. */
  judgedBy: "model" | "code";
}

/**
 * Compose the model's answers and the code-owned rules into one report.
 * Deterministic: same answers in, same report out.
 */
export function composeEvaluation(
  answers: SystemOneResult["answers"],
  context: { wordCount: number; model: string; usage: Usage | null },
): EvaluationResult {
  const criteria = SCORE_IDS.map((id) => toCriterionBand(id, readScore(answers, id)));
  const checks: EvaluationChecks = {
    positionClear: readNoul(answers, "position_clear"),
    paragraphingAdequate: readNoul(answers, "paragraphing_adequate"),
    memorisedResponse: readNoul(answers, "memorised_response"),
  };

  const length = assessLength(context.wordCount);
  const warnings: string[] = [];
  if (length.note !== null) warnings.push(length.note);

  if (checks.memorisedResponse !== null && checks.memorisedResponse >= MEMORISED_THRESHOLD) {
    warnings.push(
      `The model reads this as a memorised or off-topic response (probability ${checks.memorisedResponse.toFixed(2)}). Band 0 on Task Response covers a totally memorised response, so treat the bands below as unreliable.`,
    );
  }

  const lowConfidence = criteria.filter((criterion) => criterion.needsReview);
  if (lowConfidence.length > 0) {
    warnings.push(
      `Low confidence (under ${LOW_CONFIDENCE}) on ${lowConfidence.map((criterion) => criterion.short).join(", ")}. The answer's probabilities are spread across bands, which usually means the essay sits between two descriptors.`,
    );
  }

  return {
    overallBand: overallBand(criteria.map((criterion) => criterion.band)),
    criteria,
    checks,
    length,
    needsReview: lowConfidence.length > 0 || warnings.length > 0,
    warnings,
    model: context.model,
    usage: context.usage,
    judgedBy: "model",
  };
}

/**
 * Band 0 without a model call: an empty or near-empty response is a code-owned
 * fact, so there is nothing to ask the model about.
 */
export function noAttemptResult(wordCount: number, model = DEFAULT_MODEL): EvaluationResult {
  const length = assessLength(wordCount);
  const criteria = SCORE_IDS.map((id) =>
    toCriterionBand(id, { score: 0, confidence: 1, probabilities: { "0": 1 } }),
  );
  return {
    overallBand: 0,
    criteria,
    checks: { positionClear: null, paragraphingAdequate: null, memorisedResponse: null },
    length,
    needsReview: true,
    warnings: [length.note ?? "No response was submitted."],
    model,
    usage: null,
    judgedBy: "code",
  };
}

export interface EvaluateOptions {
  prompt: string;
  response: string;
  apiKey: string;
  model?: string;
  minimumWords?: number;
  deps?: ClientDeps;
}

/**
 * One evaluation: guard, one TypeSafe request, compose in code.
 * Throws TypeSafeError only when the call itself fails.
 */
export async function evaluateEssay(options: EvaluateOptions): Promise<EvaluationResult> {
  const model = options.model ?? DEFAULT_MODEL;
  const minimumWords = options.minimumWords ?? 250;
  const wordCount = countWords(options.response);

  // Deterministic guard: no attempt, no model call.
  if (wordCount < NON_ATTEMPT_WORDS) return noAttemptResult(wordCount, model);

  const result = await askSystemOne(
    {
      state: buildState(options.prompt, options.response, wordCount, minimumWords),
      model,
      questions: buildQuestions(),
    },
    options.apiKey,
    options.deps ?? {},
  );

  return composeEvaluation(result.answers, { wordCount, model: result.model, usage: result.usage });
}