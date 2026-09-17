/**
 * IELTS Writing Task 2 public-version band descriptors.
 *
 * `bands[n]` is the official descriptor for band `n`, so the array index is the
 * band number, 0..9. The level order matters: TypeSafe Score `criteria` must run
 * from the low end of the scale to the high end, and level 0 in the response maps
 * back to band 0 here.
 *
 * The public version of the sheet leaves Coherence and Cohesion, Lexical Resource
 * and Grammatical Range and Accuracy blank at band 0, because a response that
 * "does not attend" cannot be assessed on those criteria. Those three entries say
 * so explicitly rather than inventing a descriptor.
 *
 * Descriptors are the public-version wording supplied for this project.
 */

export type CriterionId =
  | "task_response"
  | "coherence_cohesion"
  | "lexical_resource"
  | "grammatical_range_accuracy";

export interface Criterion {
  id: CriterionId;
  /** Full name as it appears on the IELTS score report. */
  name: string;
  /** Short label for compact UI. */
  short: string;
  /** Index = band number. Length is always 10. */
  bands: string[];
}

/** Number of bands on the public descriptor sheet: 0..9. */
export const BAND_COUNT = 10;

/** Highest band obtainable on any criterion. */
export const TOP_BAND = BAND_COUNT - 1;

const NOT_ASSESSABLE =
  "No assessable response: the public version of the band descriptors leaves this criterion blank at band 0 because a response that does not attend cannot be assessed on it.";

export const CRITERIA: readonly Criterion[] = [
  {
    id: "task_response",
    name: "Task Response",
    short: "TR",
    bands: [
      "Does not attend; does not attempt the task in any way; writes a totally memorised response.",
      "Answer is completely unrelated to the task.",
      "Barely responds to the task; does not express a position; may attempt to present one or two ideas but there is no development.",
      "Does not adequately address any part of the task; does not express a clear position; presents few ideas, which are largely undeveloped or irrelevant.",
      "Responds to the task only in a minimal way or the answer is tangential; the format may be inappropriate; presents a position but this is unclear; presents some main ideas but these are difficult to identify and may be repetitive, irrelevant or not well supported.",
      "Addresses the task only partially; the format may be inappropriate in places; expresses a position but the development is not always clear and there may be no conclusions drawn; presents some main ideas but these are limited and not sufficiently developed; there may be irrelevant detail.",
      "Addresses all parts of the task although some parts may be more fully covered than others; presents a relevant position although the conclusions may become unclear or repetitive; presents relevant main ideas but some may be inadequately developed or unclear.",
      "Addresses all parts of the task; presents a clear position throughout the response; presents, extends and supports main ideas, but there may be a tendency to over-generalise and/or supporting ideas may lack focus.",
      "Sufficiently addresses all parts of the task; presents a well-developed response to the question with relevant, extended and supported ideas.",
      "Fully addresses all parts of the task; presents a fully developed position in answer to the question with relevant, fully extended and well supported ideas.",
    ],
  },
  {
    id: "coherence_cohesion",
    name: "Coherence and Cohesion",
    short: "CC",
    bands: [
      NOT_ASSESSABLE,
      "Fails to communicate any message.",
      "Has very little control of organisational features.",
      "Does not organise ideas logically; may use a very limited range of cohesive devices, and those used may not indicate a logical relationship between ideas.",
      "Presents information and ideas but these are not arranged coherently and there is no clear progression in the response; uses some basic cohesive devices but these may be inaccurate or repetitive; may not write in paragraphs or their use may be confusing.",
      "Presents information with some organisation but there may be a lack of overall progression; makes inadequate, inaccurate or over-use of cohesive devices; may be repetitive because of lack of referencing and substitution; may not write in paragraphs, or paragraphing may be inadequate.",
      "Arranges information and ideas coherently and there is a clear overall progression; uses cohesive devices effectively, but cohesion within and/or between sentences may be faulty or mechanical; may not always use referencing clearly or appropriately; uses paragraphing, but not always logically.",
      "Logically organises information and ideas; there is clear progression throughout; uses a range of cohesive devices appropriately although there may be some under- or over-use; presents a clear central topic within each paragraph.",
      "Sequences information and ideas logically; manages all aspects of cohesion well; uses paragraphing sufficiently and appropriately.",
      "Uses cohesion in such a way that it attracts no attention; skilfully manages paragraphing.",
    ],
  },
  {
    id: "lexical_resource",
    name: "Lexical Resource",
    short: "LR",
    bands: [
      NOT_ASSESSABLE,
      "Can only use a few isolated words.",
      "Uses an extremely limited range of vocabulary; essentially no control of word formation and/or spelling.",
      "Uses only a very limited range of words and expressions with very limited control of word formation and/or spelling; errors may severely distort the message.",
      "Uses only basic vocabulary which may be used repetitively or which may be inappropriate for the task; has limited control of word formation and/or spelling; errors may cause strain for the reader.",
      "Uses a limited range of vocabulary, but this is minimally adequate for the task; may make noticeable errors in spelling and/or word formation that may cause some difficulty for the reader.",
      "Uses an adequate range of vocabulary for the task; attempts to use less common vocabulary but with some inaccuracy; makes some errors in spelling and/or word formation, but they do not impede communication.",
      "Uses a sufficient range of vocabulary to allow some flexibility and precision; uses less common lexical items with some awareness of style and collocation; may produce occasional errors in word choice, spelling and/or word formation.",
      "Uses a wide range of vocabulary fluently and flexibly to convey precise meanings; skilfully uses uncommon lexical items but there may be occasional inaccuracies in word choice and collocation; produces rare errors in spelling and/or word formation.",
      "Uses a wide range of vocabulary with very natural and sophisticated control of lexical features; rare minor errors occur only as 'slips'.",
    ],
  },
  {
    id: "grammatical_range_accuracy",
    name: "Grammatical Range and Accuracy",
    short: "GRA",
    bands: [
      NOT_ASSESSABLE,
      "Cannot use sentence forms at all.",
      "Cannot use sentence forms except in memorised phrases.",
      "Attempts sentence forms but errors in grammar and punctuation predominate and distort the meaning.",
      "Uses only a very limited range of structures with only rare use of subordinate clauses; some structures are accurate but errors predominate, and punctuation is often faulty.",
      "Uses only a limited range of structures; attempts complex sentences but these tend to be less accurate than simple sentences; may make frequent grammatical errors and punctuation may be faulty; errors can cause some difficulty for the reader.",
      "Uses a mix of simple and complex sentence forms; makes some errors in grammar and punctuation but they rarely reduce communication.",
      "Uses a variety of complex structures; produces frequent error-free sentences; has good control of grammar and punctuation but may make a few errors.",
      "Uses a wide range of structures; the majority of sentences are error-free; makes only very occasional errors or inappropriacies.",
      "Uses a wide range of structures with full flexibility and accuracy; rare minor errors occur only as 'slips'.",
    ],
  },
] as const;

/** The ordered band levels for a criterion, low end first — TypeSafe Score `criteria`. */
export function bandsFor(id: CriterionId): string[] {
  const criterion = CRITERIA.find((entry) => entry.id === id);
  if (!criterion) throw new Error(`Unknown criterion: ${id}`);
  return criterion.bands;
}

/**
 * Official wording for the band achieved.
 *
 * The sheet has whole bands only, so a half band maps down to the whole band at
 * or below it: band 6.5 is reported against the band 6 descriptor, with band 7 as
 * the next target. Clamps out-of-range input.
 */
export function descriptorFor(id: CriterionId, band: number): string {
  const bands = bandsFor(id);
  const index = Math.min(Math.max(Math.floor(band), 0), bands.length - 1);
  const descriptor = bands[index];
  if (descriptor === undefined) throw new Error(`No descriptor at band ${index} for ${id}`);
  return descriptor;
}

/** Name and short label for a criterion, for display. */
export function criterionMeta(id: CriterionId): Criterion {
  const criterion = CRITERIA.find((entry) => entry.id === id);
  if (!criterion) throw new Error(`Unknown criterion: ${id}`);
  return criterion;
}