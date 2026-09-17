/**
 * Minimal TypeSafe System One client over the HTTP API.
 *
 * Endpoint, request and response shapes follow the TypeSafe API reference:
 * https://docs.typesafe.ai/api — POST https://api.typesafe.ai/v1/systemone
 *
 * We call the HTTP API directly rather than the SDK so the request shape stays
 * visible in the repo. The SDK's default retry behaviour is reimplemented here:
 * 429 and 529 are retried with exponential backoff, honouring `retry-after`.
 */

export const TYPESAFE_URL = "https://api.typesafe.ai/v1/systemone";

/**
 * The model alias required by the TypeSafe API. This is the current stable System
 * One model; the API only accepts its own aliases and versioned ids here, and the
 * response reports the versioned id that answered. Override with TYPESAFE_MODEL.
 */
export const DEFAULT_MODEL = "jev-latest";

export type EntryType = string | Record<string, unknown> | readonly unknown[] | null;

export interface ScoreQuestion {
  type: "score";
  instructions: EntryType;
  /** Ordered level descriptions, low end first. 2 to 10 levels. */
  criteria: EntryType[];
}

export interface NoulQuestion {
  type: "noul";
  instructions: EntryType;
  criteria?: { true?: EntryType; false?: EntryType };
}

export type Question = ScoreQuestion | NoulQuestion;

export interface SystemOneRequest {
  state: unknown;
  model?: string;
  questions: Record<string, Question>;
}

export interface ScoreAnswer {
  type: "score";
  score: number;
  legend: Record<string, EntryType>;
  probabilities: Record<string, number>;
  confidence: number;
}

export interface NoulAnswer {
  type: "noul";
  noul: number;
}

export type Answer = ScoreAnswer | NoulAnswer;

export interface Usage {
  input_tokens: number;
  output_tokens: number;
}

export interface SystemOneResult {
  model: string;
  answers: Record<string, Answer>;
  usage: Usage;
}

/** HTTP statuses worth retrying: rate limit, overload, and server faults. */
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504, 529]);

const MAX_ATTEMPTS = 4;

export class TypeSafeError extends Error {
  readonly status: number;
  readonly retryable: boolean;
  readonly body: string;

  constructor(message: string, options: { status: number; retryable: boolean; body?: string; cause?: unknown }) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "TypeSafeError";
    this.status = options.status;
    this.retryable = options.retryable;
    this.body = options.body ?? "";
  }
}

export interface ClientDeps {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  maxAttempts?: number;
  /** Abort and give up on a single attempt after this long. */
  timeoutMs?: number;
}

function timeoutError(): Error {
  const error = new Error("upstream request timed out");
  error.name = "TimeoutError";
  return error;
}

function backoffDelay(attempt: number): number {
  return Math.min(500 * 2 ** (attempt - 1), 8000);
}

function suggestedDelay(response: Response, attempt: number): number {
  const header = response.headers.get("retry-after");
  const seconds = header === null ? Number.NaN : Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 30000);
  return backoffDelay(attempt);
}

function describeStatus(status: number, body: string): string {
  const detail = body.trim().slice(0, 500);
  const suffix = detail.length > 0 ? ` Response body: ${detail}` : "";
  switch (status) {
    case 401:
      return `TypeSafe rejected the API key (401 Unauthorized). Check TYPESAFE_API_KEY.${suffix}`;
    case 422:
      return `TypeSafe rejected the request body (422 Unprocessable Entity).${suffix}`;
    case 429:
      return `TypeSafe rate limit reached (429 Too Many Requests).${suffix}`;
    case 529:
      return `TypeSafe is temporarily overloaded (529 Overloaded).${suffix}`;
    default:
      return `TypeSafe request failed with status ${status}.${suffix}`;
  }
}

function assertShape(payload: unknown): SystemOneResult {
  if (typeof payload !== "object" || payload === null) {
    throw new TypeSafeError("TypeSafe returned a non-object response body.", { status: 0, retryable: false });
  }
  const candidate = payload as Partial<SystemOneResult>;
  if (typeof candidate.model !== "string" || typeof candidate.answers !== "object" || candidate.answers === null) {
    throw new TypeSafeError("TypeSafe response is missing `model` or `answers`.", { status: 0, retryable: false });
  }
  const usage = candidate.usage ?? { input_tokens: 0, output_tokens: 0 };
  return { model: candidate.model, answers: candidate.answers, usage };
}

/**
 * Send one request with all questions, retrying retryable failures.
 * Questions in a single request are evaluated in parallel, and adding questions
 * to a request costs a few tokens rather than another round trip.
 */
export async function askSystemOne(
  request: SystemOneRequest,
  apiKey: string,
  deps: ClientDeps = {},
): Promise<SystemOneResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const maxAttempts = deps.maxAttempts ?? MAX_ATTEMPTS;
  const timeoutMs = deps.timeoutMs ?? 0;
  const body = JSON.stringify({ model: DEFAULT_MODEL, ...request });

  let lastError: TypeSafeError | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let response: Response;
    try {
      response = await fetchImpl(TYPESAFE_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body,
        signal: timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined,
      });
    } catch (cause) {
      const name = cause instanceof Error ? cause.name : "";
      // A timed-out attempt is not retried: the request may have been received and
      // billed, so retrying would spend the operator's credits twice for one action.
      const timedOut = name === "TimeoutError" || name === "AbortError";
      const message = timedOut ? `no response within ${timeoutMs}ms` : cause instanceof Error ? cause.message : String(cause);
      lastError = new TypeSafeError(`Could not reach ${TYPESAFE_URL}: ${message}`, {
        status: 0,
        retryable: !timedOut,
        cause,
      });
      if (lastError.retryable && attempt < maxAttempts) {
        await sleep(backoffDelay(attempt));
        continue;
      }
      throw lastError;
    }

    if (response.ok) {
      return assertShape(await response.json());
    }

    const text = await response.text().catch(() => "");
    lastError = new TypeSafeError(describeStatus(response.status, text), {
      status: response.status,
      retryable: RETRYABLE_STATUSES.has(response.status),
      body: text,
    });
    if (lastError.retryable && attempt < maxAttempts) {
      await sleep(suggestedDelay(response, attempt));
      continue;
    }
    throw lastError;
  }

  throw lastError ?? new TypeSafeError("TypeSafe request failed.", { status: 0, retryable: false });
}

/** Read a Score answer by question id, failing loudly if it is missing or mistyped. */
export function readScore(answers: Record<string, Answer>, id: string): ScoreAnswer {
  const answer = answers[id];
  if (answer === undefined) throw new TypeSafeError(`TypeSafe returned no answer for "${id}".`, { status: 0, retryable: false });
  if (answer.type !== "score") {
    throw new TypeSafeError(`Expected a score answer for "${id}", got "${answer.type}".`, { status: 0, retryable: false });
  }
  return answer;
}

/** Read a Noul answer by question id; null when the question was not answered. */
export function readNoul(answers: Record<string, Answer>, id: string): number | null {
  const answer = answers[id];
  if (answer === undefined || answer.type !== "noul") return null;
  return answer.noul;
}