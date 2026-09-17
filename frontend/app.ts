/// <reference lib="dom" />
/**
 * Browser app for IELTS Scores Explained.
 *
 * Bundled by Bun from this `.ts` file; no framework and no runtime dependency.
 * It only talks to this server — the API key never reaches the browser.
 *
 * Layout behaviour worth knowing: the page is a single column on a phone, so the
 * result panel sits below the form. When a result arrives the panel is scrolled
 * into view and its heading takes focus, both so a phone user is not left
 * scrolling to find their bands and so a screen reader lands on the new content.
 */

import type { EvaluationResult } from "../src/evaluate.ts";
import type { WritingTask } from "../src/tasks.ts";

interface Health {
  ok: boolean;
  model: string;
  apiKeyConfigured: boolean;
  minimumWords: number;
}

type EvaluateResponse =
  | { ok: true; result: EvaluationResult }
  | { ok: false; error: { message: string; status: number; code: string } };

/** A deliberately mid-band sample, written for this project, for trying the app out. */
const SAMPLE_ESSAY = `Whether employees are better off working from home or in an office is a question that many companies are still debating. In my view, remote work suits some roles and some people far better than others, so a completely flexible arrangement is the most sensible approach.

The strongest argument for working from home is the time and money it saves. Employees who no longer commute for an hour each way gain back a significant part of their day, and that time is often used for family, exercise or simply resting. This can improve both productivity and well-being. Furthermore, companies can reduce the cost of office space and hire talented staff who live far from the city, which widens the pool of applicants considerably.

On the other hand, an office brings benefits that are difficult to reproduce at home. New employees learn a great deal simply by sitting near experienced colleagues, and problems are solved faster when a team can talk them through face to face. Some workers also find that a separate workplace helps them to concentrate, because at home the boundary between work and private life becomes blurred. In addition, people who live alone may feel isolated when they work remotely every day.

In conclusion, although working from home offers clear advantages in time, cost and flexibility, the office still has value for training, teamwork and personal contact. Rather than forcing everyone into one model, employers should allow staff to split their week between the two, which combines the main benefits of each and avoids the worst disadvantages.`;

const EVALUATE_LABEL = "Evaluate my writing";

const $ = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`Missing element #${id}`);
  return element as T;
};

const promptEl = $<HTMLTextAreaElement>("prompt");
const ownTaskEl = $<HTMLButtonElement>("own-task");
const formatEl = $<HTMLSpanElement>("task-format");
const requirementEl = $<HTMLSpanElement>("task-requirement");
const responseEl = $<HTMLTextAreaElement>("response");
const wordCountEl = $<HTMLSpanElement>("wordcount");
const lengthNoteEl = $<HTMLSpanElement>("length-note");
const progressEl = $<HTMLDivElement>("word-progress");
const progressFillEl = progressEl.querySelector("span");
const evaluateEl = $<HTMLButtonElement>("evaluate");
const newTaskEl = $<HTMLButtonElement>("new-task");
const sampleEl = $<HTMLButtonElement>("sample");
const hintEl = $<HTMLParagraphElement>("hint");
const resultsEl = $<HTMLElement>("results");
const resultsEmptyEl = $<HTMLDivElement>("results-empty");
const resultBodyEl = $<HTMLDivElement>("result-body");
const resultHeadingEl = $<HTMLHeadingElement>("result-heading");
const resultNoteEl = $<HTMLSpanElement>("result-note");
const statusDotEl = $<HTMLSpanElement>("status-dot");
const statusTextEl = $<HTMLSpanElement>("status-text");
const footerModelEl = $<HTMLSpanElement>("footer-model");
const footerUsageEl = $<HTMLSpanElement>("footer-usage");

let currentTask: WritingTask | null = null;
let minimumWords = 250;
let evaluating = false;

const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const FORMAT_LABELS: Record<string, string> = {
  opinion: "Opinion (agree or disagree)",
  discussion: "Discussion of both views",
  problem_solution: "Problems and solutions",
  advantages_disadvantages: "Advantages and disadvantages",
  two_part: "Two-part question",
};

function countWords(text: string): number {
  return text.trim().length === 0 ? 0 : text.trim().split(/\s+/).length;
}

function setStatus(text: string, state: "ok" | "bad" | "idle"): void {
  statusTextEl.textContent = text;
  statusDotEl.className = `dot${state === "idle" ? "" : ` ${state}`}`;
}

function setHint(message: string, isError = false): void {
  hintEl.textContent = message;
  hintEl.className = isError ? "hint error" : "hint";
}

/** Bring a freshly rendered result into view, and put the cursor there too. */
function revealResults(): void {
  resultHeadingEl.focus({ preventScroll: true });
  resultsEl.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
}

async function refreshHealth(): Promise<void> {
  try {
    const health = (await (await fetch("/api/health")).json()) as Health;
    minimumWords = health.minimumWords;
    requirementEl.textContent = `At least ${minimumWords} words`;
    progressEl.setAttribute("aria-valuemax", String(minimumWords));
    footerModelEl.textContent = `model: ${health.model}`;
    if (health.apiKeyConfigured === false) {
      setStatus("Service not configured", "bad");
      setHint("This site has no evaluation credentials configured, so it cannot score answers yet.", true);
    } else {
      setStatus("Ready", "ok");
      setHint("");
    }
  } catch {
    setStatus("Server unreachable", "bad");
  }
}

async function loadTask(exclude?: string): Promise<void> {
  const query = exclude === undefined ? "" : `?exclude=${encodeURIComponent(exclude)}`;
  const payload = (await (await fetch(`/api/tasks/random${query}`)).json()) as { task: WritingTask };
  currentTask = payload.task;
  promptEl.value = payload.task.prompt;
  promptEl.readOnly = true;
  promptEl.classList.remove("custom");
  formatEl.textContent = FORMAT_LABELS[payload.task.format] ?? payload.task.format;
  fitPromptBox();
}

/**
 * A loaded question is reference text, not an input: it must be readable in full
 * without an inner scrollbar, so the box is sized to its content. Once the
 * candidate unlocks it to write their own, it behaves like a normal text box.
 */
function fitPromptBox(): void {
  if (promptEl.readOnly) {
    promptEl.style.height = "auto";
    promptEl.style.height = `${promptEl.scrollHeight + 2}px`;
  } else {
    promptEl.style.height = "";
  }
}

/** Unlock the question box so the candidate can type their own Task 2 question. */
function startOwnTask(): void {
  currentTask = null;
  promptEl.readOnly = false;
  promptEl.classList.add("custom");
  promptEl.value = "";
  fitPromptBox();
  formatEl.textContent = "Your own question";
  setHint("Type your own Task 2 question above, then write your answer below.");
  promptEl.focus();
}

/**
 * Words written, shown three ways: the count, how many are still missing, and a
 * bar that fills as the answer approaches the minimum.
 */
function updateCounter(): void {
  const words = countWords(responseEl.value);
  const reached = words >= minimumWords;

  wordCountEl.textContent = `${words} word${words === 1 ? "" : "s"}`;
  wordCountEl.className = words === 0 ? "" : reached ? "done" : "short";

  if (progressFillEl !== null) {
    progressFillEl.style.width = `${Math.min(100, (words / minimumWords) * 100)}%`;
  }
  progressEl.classList.toggle("done", reached);
  progressEl.setAttribute("aria-valuenow", String(Math.min(words, minimumWords)));

  if (words === 0) {
    lengthNoteEl.textContent = "";
    lengthNoteEl.className = "";
  } else if (reached) {
    lengthNoteEl.textContent = "minimum reached";
    lengthNoteEl.className = "done";
  } else {
    lengthNoteEl.textContent = `${minimumWords - words} more to reach ${minimumWords}`;
    lengthNoteEl.className = "short";
  }
}

/**
 * Probability mass per band on an absolute 0-1 scale, plus a text summary. The
 * bars themselves are hidden from assistive technology: ten unlabelled boxes say
 * nothing useful, so the sentence above them carries the meaning.
 */
function renderDistribution(result: EvaluationResult, criterionIndex: number): DocumentFragment {
  const fragment = document.createDocumentFragment();
  const criterion = result.criteria[criterionIndex];
  if (criterion === undefined) return fragment;

  const ranked = [...criterion.distribution].sort((a, b) => b.probability - a.probability);
  const [first, second] = ranked;
  const summary = document.createElement("div");
  summary.className = "criterion-sub";
  summary.textContent =
    first === undefined
      ? "No probability distribution was returned."
      : `Most likely band ${first.band} (${Math.round(first.probability * 100)}%)` +
        (second !== undefined && second.probability >= 0.05
          ? `, then band ${second.band} (${Math.round(second.probability * 100)}%)`
          : "");
  fragment.append(summary);

  const bars = document.createElement("div");
  bars.className = "dist";
  bars.setAttribute("aria-hidden", "true");

  const byBand = new Map(criterion.distribution.map((entry) => [entry.band, entry.probability]));
  for (let band = 0; band <= 9; band += 1) {
    const column = document.createElement("div");
    column.className = "col";

    const probability = byBand.get(band) ?? 0;
    const hot = band === Math.round(criterion.band);

    const bar = document.createElement("div");
    bar.className = hot ? "bar hot" : "bar";
    bar.style.height = `${Math.max(probability * 100, 1.5)}%`;
    bar.title = `band ${band}: ${(probability * 100).toFixed(1)}%`;

    const tick = document.createElement("span");
    tick.className = hot ? "tick hot" : "tick";
    tick.textContent = String(band);

    column.append(bar, tick);
    bars.append(column);
  }

  fragment.append(bars);
  return fragment;
}

function checkCard(label: string, value: number | null, highIsBad: boolean): HTMLDivElement {
  const card = document.createElement("div");
  card.className = "check";

  const labelEl = document.createElement("div");
  labelEl.className = "label";
  labelEl.textContent = label;

  const valueEl = document.createElement("div");
  valueEl.className = "value";
  if (value === null) {
    valueEl.textContent = "not measured";
    valueEl.classList.add("muted");
  } else {
    valueEl.textContent = `${Math.round(value * 100)}%`;
    const strong = value >= 0.7;
    if (highIsBad ? strong : !strong) valueEl.classList.add(strong ? "high" : "low");
  }

  card.append(labelEl, valueEl);
  return card;
}

function renderResult(result: EvaluationResult): void {
  resultsEmptyEl.hidden = true;
  resultBodyEl.replaceChildren();

  const overall = document.createElement("div");
  overall.className = "overall";

  const bandEl = document.createElement("div");
  bandEl.className = "overall-band";
  bandEl.textContent = result.overallBand.toFixed(1);

  const overallText = document.createElement("div");
  const overallLabel = document.createElement("div");
  overallLabel.className = "overall-label";
  overallLabel.textContent = "Overall band";
  const overallRule = document.createElement("div");
  overallRule.className = "overall-rule";
  const bands = result.criteria.map((criterion) => criterion.band.toFixed(1)).join(", ");
  overallRule.textContent = `mean of ${bands}, rounded to the nearest half band`;
  overallText.append(overallLabel, overallRule);
  overall.append(bandEl, overallText);
  resultBodyEl.append(overall);

  if (result.warnings.length > 0) {
    const box = document.createElement("div");
    box.className = "warnings";
    for (const warning of result.warnings) {
      const line = document.createElement("p");
      line.textContent = warning;
      box.append(line);
    }
    resultBodyEl.append(box);
  }

  result.criteria.forEach((criterion, index) => {
    const card = document.createElement("div");
    card.className = "criterion";

    const head = document.createElement("div");
    head.className = "criterion-head";
    const name = document.createElement("span");
    name.className = "criterion-name";
    name.textContent = criterion.name;
    const band = document.createElement("span");
    band.className = "criterion-band";
    band.textContent = criterion.band.toFixed(1);
    head.append(name, band);

    const sub = document.createElement("div");
    sub.className = "criterion-sub";
    sub.textContent = `Raw score ${criterion.rawScore.toFixed(2)} → band ${criterion.band.toFixed(1)} · confidence ${criterion.confidence.toFixed(2)}`;

    const descriptor = document.createElement("div");
    descriptor.className = "descriptor";
    descriptor.textContent = criterion.descriptor;

    card.append(head, sub, descriptor);

    if (criterion.nextBand !== null && criterion.nextDescriptor !== null) {
      const target = document.createElement("div");
      target.className = "next-target";
      const targetLabel = document.createElement("div");
      targetLabel.className = "criterion-sub";
      targetLabel.textContent = `To reach band ${criterion.nextBand}`;
      const targetText = document.createElement("div");
      targetText.textContent = criterion.nextDescriptor;
      target.append(targetLabel, targetText);
      card.append(target);
    }

    card.append(renderDistribution(result, index));
    resultBodyEl.append(card);
  });

  const checksHeading = document.createElement("h3");
  checksHeading.className = "checks-heading";
  checksHeading.textContent = "What the checks said";

  const checks = document.createElement("div");
  checks.className = "checks";
  checks.append(
    checkCard("Clear, consistent position", result.checks.positionClear, false),
    checkCard("Paragraphing adequate", result.checks.paragraphingAdequate, false),
    checkCard("Reads as memorised / off-topic", result.checks.memorisedResponse, true),
  );
  resultBodyEl.append(checksHeading, checks);

  footerUsageEl.textContent =
    result.usage === null
      ? result.judgedBy === "code"
        ? "settled by code — no model call"
        : ""
      : `${result.usage.input_tokens} input tokens, ${result.usage.output_tokens} output tokens`;
  footerModelEl.textContent = `model: ${result.model}`;
  resultNoteEl.textContent = `overall ${result.overallBand.toFixed(1)}`;

  revealResults();
}

function renderError(message: string): void {
  resultsEmptyEl.hidden = true;
  resultBodyEl.replaceChildren();

  const box = document.createElement("div");
  box.className = "warnings";
  const line = document.createElement("p");
  line.textContent = message;
  box.append(line);
  resultBodyEl.append(box);

  resultNoteEl.textContent = "not scored";
  revealResults();
}

async function evaluate(): Promise<void> {
  // One request per press: a double tap or a held shortcut must not buy two.
  if (evaluating) return;

  const prompt = promptEl.value.trim();
  if (prompt.length === 0) {
    setHint("Add or write a Task 2 question before evaluating.", true);
    promptEl.focus();
    return;
  }

  evaluating = true;
  evaluateEl.disabled = true;
  evaluateEl.setAttribute("aria-busy", "true");
  evaluateEl.textContent = "Evaluating…";
  resultNoteEl.textContent = "scoring…";
  setHint("Reading your answer against the four criteria…");

  try {
    const response = await fetch("/api/evaluate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt, response: responseEl.value }),
    });
    const payload = (await response.json()) as EvaluateResponse;

    if (payload.ok) {
      renderResult(payload.result);
      setHint("");
    } else {
      renderError(payload.error.message);
      setHint(payload.error.message, true);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    renderError(`Could not reach the server: ${message}`);
    setHint("Evaluation failed.", true);
  } finally {
    evaluating = false;
    evaluateEl.disabled = false;
    evaluateEl.removeAttribute("aria-busy");
    evaluateEl.textContent = EVALUATE_LABEL;
  }
}

newTaskEl.addEventListener("click", () => {
  void loadTask(currentTask?.id);
});

ownTaskEl.addEventListener("click", () => {
  startOwnTask();
});

sampleEl.addEventListener("click", () => {
  responseEl.value = SAMPLE_ESSAY;
  updateCounter();
  responseEl.focus();
  responseEl.setSelectionRange(responseEl.value.length, responseEl.value.length);
});

responseEl.addEventListener("input", updateCounter);

// Re-fit the question when the text re-wraps, e.g. on a phone rotation.
window.addEventListener("resize", () => {
  if (promptEl.readOnly) fitPromptBox();
});

responseEl.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    void evaluate();
  }
});

evaluateEl.addEventListener("click", () => {
  void evaluate();
});

void (async () => {
  await refreshHealth();
  await loadTask();
  updateCounter();
})();