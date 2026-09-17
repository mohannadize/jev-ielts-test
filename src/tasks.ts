/**
 * Writing Task 2 prompts to show the candidate.
 *
 * These are representative Task 2 questions written for this project in the
 * official prompt formats. They are not claimed to be past exam papers.
 */

export type TaskFormat =
  | "opinion"
  | "discussion"
  | "problem_solution"
  | "advantages_disadvantages"
  | "two_part";

export interface WritingTask {
  id: string;
  format: TaskFormat;
  /** The question text shown to the candidate, including the instruction line. */
  prompt: string;
}

export const TASKS: readonly WritingTask[] = [
  {
    id: "remote-work",
    format: "discussion",
    prompt:
      "Some people believe that working from home is better for employees, while others think that working in an office brings more benefits.\n\n" +
      "Discuss both views and give your own opinion.\n\n" +
      "Write at least 250 words.",
  },
  {
    id: "city-traffic",
    format: "problem_solution",
    prompt:
      "In many large cities, traffic congestion has become a serious problem that affects both the economy and the environment.\n\n" +
      "What are the causes of this problem and what measures could be taken to solve it?\n\n" +
      "Write at least 250 words.",
  },
  {
    id: "university-fees",
    format: "opinion",
    prompt:
      "Some people think that university education should be free for all students, while others believe that students should pay for at least part of their studies.\n\n" +
      "To what extent do you agree or disagree?\n\n" +
      "Write at least 250 words.",
  },
  {
    id: "screen-time-children",
    format: "problem_solution",
    prompt:
      "Children in many countries now spend several hours a day looking at screens.\n\n" +
      "What problems can this cause, and what can parents and schools do about them?\n\n" +
      "Write at least 250 words.",
  },
  {
    id: "single-use-plastic",
    format: "advantages_disadvantages",
    prompt:
      "Some countries have banned single-use plastic items such as bags, straws and cutlery.\n\n" +
      "What are the advantages and disadvantages of such bans?\n\n" +
      "Write at least 250 words.",
  },
  {
    id: "history-school-subject",
    format: "two_part",
    prompt:
      "In some schools, history is a compulsory subject, while in others students may choose whether to study it.\n\n" +
      "Why do you think this difference exists? Should history be compulsory for all school students?\n\n" +
      "Write at least 250 words.",
  },
  {
    id: "social-media-news",
    format: "discussion",
    prompt:
      "More people now get their news from social media rather than from newspapers, radio or television.\n\n" +
      "Discuss the advantages and disadvantages of this trend, and give your own opinion.\n\n" +
      "Write at least 250 words.",
  },
  {
    id: "ageing-population",
    format: "problem_solution",
    prompt:
      "In many countries the average age of the population is increasing.\n\n" +
      "What problems does an ageing population create for society, and how might governments address them?\n\n" +
      "Write at least 250 words.",
  },
] as const;

export function getTask(id: string): WritingTask | undefined {
  return TASKS.find((task) => task.id === id);
}

/** A prompt to show on first load, and for the "new question" button. */
export function pickTask(excludeId?: string): WritingTask {
  const pool = excludeId ? TASKS.filter((task) => task.id !== excludeId) : TASKS;
  const candidates = pool.length > 0 ? pool : TASKS;
  const choice = candidates[Math.floor(Math.random() * candidates.length)];
  return choice ?? TASKS[0]!;
}