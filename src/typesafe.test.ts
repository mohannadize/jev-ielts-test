import { describe, expect, test } from "bun:test";

import { TypeSafeError, TYPESAFE_URL, askSystemOne, readNoul, readScore } from "./typesafe.ts";
import type { SystemOneResult } from "./typesafe.ts";

const OK_BODY: SystemOneResult = {
  model: "jev-1.13.0",
  answers: { is_urgent: { type: "noul", noul: 0.92 } },
  usage: { input_tokens: 312, output_tokens: 48 },
};

function okResponse(): Response {
  return new Response(JSON.stringify(OK_BODY), { status: 200, headers: { "Content-Type": "application/json" } });
}

function errorResponse(status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ error: "nope" }), { status, headers });
}

interface StubState {
  calls: number;
  sleeps: number[];
}

function stubFetch(responses: (Response | Error)[], state: StubState): typeof fetch {
  return (async (_input: Request | string | URL, init?: RequestInit) => {
    void init;
    const next = responses[state.calls];
    state.calls += 1;
    if (next === undefined) throw new Error("stub fetch ran out of responses");
    if (next instanceof Error) throw next;
    return next;
  }) as unknown as typeof fetch;
}

const noSleep = (state: StubState) => async (ms: number) => {
  state.sleeps.push(ms);
};

async function call(responses: (Response | Error)[], state: StubState) {
  return askSystemOne({ state: "hi", questions: { is_urgent: { type: "noul", instructions: "Urgent?" } } }, "test-key", {
    fetchImpl: stubFetch(responses, state),
    sleep: noSleep(state),
    maxAttempts: 3,
  });
}

describe("askSystemOne", () => {
  test("returns the parsed result on a 200", async () => {
    const state: StubState = { calls: 0, sleeps: [] };
    const result = await call([okResponse()], state);
    expect(state.calls).toBe(1);
    expect(state.sleeps).toEqual([]);
    expect(result.model).toBe("jev-1.13.0");
    expect(result.answers.is_urgent).toEqual({ type: "noul", noul: 0.92 });
  });

  test("retries a 429 and then succeeds", async () => {
    const state: StubState = { calls: 0, sleeps: [] };
    const result = await call([errorResponse(429), okResponse()], state);
    expect(state.calls).toBe(2);
    expect(result.answers.is_urgent).toEqual({ type: "noul", noul: 0.92 });
    expect(state.sleeps).toHaveLength(1);
  });

  test("honours retry-after instead of the default backoff", async () => {
    const state: StubState = { calls: 0, sleeps: [] };
    await call([errorResponse(529, { "retry-after": "2" }), okResponse()], state);
    expect(state.sleeps).toEqual([2000]);
  });

  test("retries a network failure", async () => {
    const state: StubState = { calls: 0, sleeps: [] };
    await call([new Error("socket hang up"), okResponse()], state);
    expect(state.calls).toBe(2);
  });

  test("gives up after maxAttempts and reports the status", async () => {
    const state: StubState = { calls: 0, sleeps: [] };
    const failure = await call([errorResponse(429), errorResponse(429), errorResponse(429)], state).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(TypeSafeError);
    expect((failure as TypeSafeError).status).toBe(429);
    expect((failure as TypeSafeError).retryable).toBe(true);
    expect(state.calls).toBe(3);
    expect(state.sleeps).toHaveLength(2);
  });

  test("does not retry a 401 and names the key in the message", async () => {
    const state: StubState = { calls: 0, sleeps: [] };
    const failure = await call([errorResponse(401)], state).catch((error: unknown) => error);
    expect(state.calls).toBe(1);
    expect(state.sleeps).toEqual([]);
    expect((failure as TypeSafeError).status).toBe(401);
    expect((failure as TypeSafeError).retryable).toBe(false);
    expect((failure as TypeSafeError).message).toContain("TYPESAFE_API_KEY");
  });

  test("does not retry a 422 and explains the rejected body", async () => {
    const state: StubState = { calls: 0, sleeps: [] };
    const failure = await call([errorResponse(422)], state).catch((error: unknown) => error);
    expect(state.calls).toBe(1);
    expect((failure as TypeSafeError).message).toContain("422");
  });

  test("sends the bearer token and the request body to the documented endpoint", async () => {
    const seen: { url?: string; init?: RequestInit } = {};
    const fetchImpl = (async (input: Request | string | URL, init?: RequestInit) => {
      seen.url = String(input);
      seen.init = init;
      return okResponse();
    }) as unknown as typeof fetch;

    await askSystemOne(
      { state: { essay: "text" }, questions: { is_urgent: { type: "noul", instructions: "Urgent?" } } },
      "secret-key",
      { fetchImpl, sleep: async () => {} },
    );

    expect(seen.url).toBe(TYPESAFE_URL);
    expect(seen.init?.method).toBe("POST");
    const headers = seen.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer secret-key");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(String(seen.init?.body))).toEqual({
      model: "jev-latest",
      state: { essay: "text" },
      questions: { is_urgent: { type: "noul", instructions: "Urgent?" } },
    });
  });

  test("rejects a response without model or answers", async () => {
    const state: StubState = { calls: 0, sleeps: [] };
    const responses = [new Response(JSON.stringify({ usage: {} }), { status: 200 })];
    const failure = await call(responses, state).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(TypeSafeError);
    expect((failure as TypeSafeError).message).toContain("missing");
  });
});

describe("answer readers", () => {
  test("readScore finds a score answer", () => {
    const answers = {
      task_response: { type: "score" as const, score: 6.5, legend: { "6": "six" }, probabilities: { "6": 0.5 }, confidence: 0.8 },
    };
    expect(readScore(answers, "task_response").score).toBe(6.5);
  });

  test("readScore fails loudly on a missing or mistyped answer", () => {
    const answers = { task_response: { type: "score" as const, score: 6, legend: {}, probabilities: {}, confidence: 1 } };
    expect(() => readScore(answers, "missing")).toThrow(/no answer/);
    expect(() => readScore({ task_response: { type: "noul" as const, noul: 0.5 } }, "task_response")).toThrow(/Expected a score/);
  });

  test("readNoul returns null for an absent question and the value otherwise", () => {
    const answers = {
      position_clear: { type: "noul" as const, noul: 0.88 },
      task_response: { type: "score" as const, score: 6, legend: {}, probabilities: {}, confidence: 1 },
    };
    expect(readNoul(answers, "position_clear")).toBe(0.88);
    expect(readNoul(answers, "memorised_response")).toBeNull();
    expect(readNoul(answers, "task_response")).toBeNull();
  });
});