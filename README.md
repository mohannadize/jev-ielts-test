# IELTS Scores Explained

A small web app for IELTS Writing Task 2 practice. It shows a question, takes your
answer, and reports a band for each of the four criteria against the official public
band descriptors.

Every band is explained rather than asserted: the app shows the official descriptor
wording for the band achieved, the descriptor for the next band up, the probability the
model placed on each band from 0 to 9, and how certain that answer was.

## How it works

Code owns the workflow. The model only answers narrow, typed questions.

```
browser ──POST /api/evaluate──▶ server
                                │  count words, decide whether there is an attempt
                                │  build state { task, essay } and 7 questions
                                ├──POST api.typesafe.ai/v1/systemone──▶ model
                                │      4 × Score  (one per criterion, 10 band levels each)
                                │      3 × Noul   (position clear, paragraphing, memorised)
                                │  round to half bands, average, look up descriptors
                                ◀──band report── browser renders it with the descriptors
```

- **Four Score questions**, one per criterion — Task Response, Coherence and Cohesion,
  Lexical Resource, Grammatical Range and Accuracy. Each gets the ten official band
  descriptors as its ordered levels, band 0 first. A Score can land between levels, which
  is what half bands are.
- **Three Noul checks** ride along in the same request: whether a position is clear and
  consistent, whether paragraphing is adequate, and whether the answer reads as memorised
  or off-topic (band 0 on Task Response covers a totally memorised response).
- **One request.** Questions in a request are evaluated in parallel and cannot see each
  other's answers, so all composition happens in code.
- **Code keeps what is countable.** Word count, the half-band rounding, the overall band,
  and the length and memorised-response rules are plain code, not model judgments.

The model alias is set by `DEFAULT_MODEL` in `src/typesafe.ts` and can be overridden with
`TYPESAFE_MODEL`.

## Running it locally

```bash
bun install
cp .env.example .env      # then put your API key in it
bun run dev               # builds the browser bundle, then runs with --hot
```

Open <http://localhost:3000>. `PORT` overrides the port.

While working on the front end it is easier to keep the bundle rebuilding and let the
server hot-reload:

```bash
bun run build:client --watch   # terminal 1
NODE_ENV=development bun --hot index.ts   # terminal 2
```

The API key comes from <https://console.typesafe.ai/settings/keys>. It stays server-side:
the browser never receives it, and it is never logged.

## Deploying on Dokploy

The app is one container: a Bun process serving the built front end plus the JSON API.
Nothing else is needed — no database, no object storage, no external cache.

Build and run settings:

| Setting | Value |
| --- | --- |
| Build type | Nixpacks |
| Repository | this repo, `main` |
| Container port | `3000` (or whatever `PORT` you set — Dokploy routes to it) |
| Health check path | `/healthz` |
| Start command | `bun run start` (also pinned in `nixpacks.toml`) |

Nixpacks detects Bun from `bun.lock`, and `nixpacks.toml` pins the phases:

```toml
[phases.install]
cmds = ["bun install --frozen-lockfile"]

[phases.build]
cmds = ["bun run build"]        # emits the browser bundle into public/

[start]
cmd = "bun run start"           # rebuilds the bundle if needed, then serves
```

Environment variables to set in Dokploy:

| Variable | Value | Why |
| --- | --- | --- |
| `TYPESAFE_API_KEY` | your key | **Secret.** Without it `/api/evaluate` refuses to run. |
| `NODE_ENV` | `production` | Turns off development tooling and the verbose error overlay. |
| `TRUST_PROXY` | `1` | Dokploy's Traefik sits directly in front of the container. Set `0` if the container port is exposed directly. |
| `PORT` | `3000` | Match this to Dokploy's container port setting. |

Everything else is optional and has a safe default — see `.env.example` and `src/config.ts`.

If you change dependencies, run `bun install` locally and commit the updated `bun.lock`,
because the image installs with `--frozen-lockfile`.

## Configuration

Every value is read once at startup in `src/config.ts`. The spend and input guards:

| Variable | Default | Meaning |
| --- | --- | --- |
| `RATE_LIMIT_PER_MINUTE` | `4` | Evaluations per client address per minute |
| `RATE_LIMIT_PER_DAY` | `30` | Evaluations per client address per day |
| `GLOBAL_DAILY_LIMIT` | `300` | Evaluations across the whole site per UTC day |
| `RATE_LIMIT_MAX_CLIENTS` | `20000` | Ceiling on tracked client keys, bounding memory |
| `MAX_WORDS` | `1200` | Longest answer accepted |
| `MAX_PROMPT_CHARS` | `2000` | Longest question accepted |
| `MAX_BODY_BYTES` | `65536` | Largest request body accepted |
| `UPSTREAM_TIMEOUT_MS` | `20000` | Give up on one upstream attempt after this |
| `MINIMUM_WORDS` | `250` | Task 2 minimum, surfaced in the interface |
| `LOG_REQUESTS` | `1` | One JSON log line per API request |
| `PUBLIC_DIAGNOSTICS` | `1` | Let `/api/health` report whether a key is configured |

Setting any limit to `0` disables that limit.

## Security

What is protected, and how:

- **Credentials.** The key lives only in the container's environment. It is never sent to
  the browser, never written to a log, and never echoed in an error. Refusals are fixed
  strings written in `src/index.ts`; upstream error detail is logged server-side only.
- **Spend.** A public endpoint spends the operator's credits, so every evaluation is
  metered before the body is parsed: per address per minute, per address per day, and a
  single instance-wide daily ceiling. The instance-wide ceiling is the backstop — it bounds
  a day's cost even if the per-address limits are evaded by rotating addresses. Counters are
  in memory, so a restart clears them; the daily ceiling is what makes that acceptable.
- **Request size.** The body is read through a byte-counting stream with a hard ceiling,
  so an oversized payload is never fully buffered. Answers are capped by word count and
  questions by character count before anything reaches the model.
- **Headers.** Every response carries a strict content policy (`default-src 'none'`, no
  inline script, same-origin only), `nosniff`, `frame-ancestors 'none'`, a no-referrer
  policy, a restrictive permissions policy and cross-origin isolation. HSTS is added only
  when the request arrived over TLS. API responses are `no-store`.
- **Static serving.** An extension allow-list, with paths that must resolve inside the
  asset directory. Source files, dotfiles, lockfiles and `.env` are refused even if they
  end up in the directory.
- **Output escaping.** The front end writes every value with `textContent`; it never builds
  HTML from data, so scores and messages cannot inject markup.
- **Escalation hygiene.** An empty or near-empty answer is settled by code as band 0
  without calling the model at all.

Two things to be deliberate about when you make this public:

1. **`TRUST_PROXY`.** With it on, the client address is read from the forwarding headers a
   proxy sets. That is correct behind Dokploy's Traefik, which appends the address it saw.
   If the container port is ever exposed directly, set `TRUST_PROXY=0`, otherwise a caller
   can supply their own header and appear as a new address each time. The instance-wide
   daily ceiling still bounds the damage either way.
2. **What is logged.** One JSON line per API request records the path, status, duration,
   client address, word count, band and token usage — never the answer text, never the
   question text, never the key. Keep that in mind if you publish logs.

## Using it

The **Task** box holds the question that will be used as the task. Three ways to fill it:

- **New question** loads one of the built-in Task 2 prompts.
- **Write my own** unlocks the box so you can type any Task 2 question yourself. The box
  turns accent-coloured while it is unlocked.
- The box is read-only until you unlock it, so a loaded question cannot be edited by
  accident. A question of your own is sent to the model exactly as typed.

Then write at least 250 words and press **Evaluate my writing**. **Insert sample essay**
fills the answer box with a mid-band sample for trying the app out. Evaluating without a
question is refused in the browser rather than sent to the API.

Writing on a phone works the same way, with a few adjustments: the layout is a single
column, every control is at least 44px tall, and the text fields are set at 16px so iOS
Safari does not zoom the page when one is focused. A bar under the answer box fills as you
approach the word minimum, and when a result arrives the page scrolls to it and moves
focus there, so you are not left hunting for your bands. On a wide screen the form stays
pinned while the results scroll beside it.

If you prefer the keyboard, `⌘`/`Ctrl` + `Enter` evaluates from inside the answer box. One
request is sent per press, so a double tap cannot buy two evaluations.

Submitting fewer than 10 words never reaches the model — the app settles that itself as
band 0, because "does not attend" is a fact about the response, not a judgment.

## Routes

| Route | What it does |
| --- | --- |
| `GET /` | the app |
| `GET /healthz` | liveness for the platform health check, no diagnostics |
| `GET /api/health` | model, limits, and whether a key is configured |
| `GET /api/tasks` | the built-in Task 2 questions |
| `GET /api/tasks/random?exclude=<id>` | a question, different from the given id when possible |
| `POST /api/evaluate` | `{ prompt, response }` → the band report |

Refusals carry a status and a code the interface can act on: `rate_limited`,
`daily_limit`, `capacity`, `body_too_large`, `too_long`, `prompt_too_long`, `bad_json`,
`bad_prompt`, `bad_response`, `method_not_allowed`, `missing_api_key` (this site is not
configured), `bad_api_key`, `rejected_request`, `upstream_busy`, `upstream_unreachable`,
`upstream_error`, `internal_error`.

## Layout

```
index.ts              Bun server: routing, guards, static files, shutdown
src/config.ts         environment configuration, defaults and validation
src/http.ts           JSON responses, visitor-facing errors, security headers
src/security.ts       client address, rate limits, daily ceilings, body size cap
src/static.ts         safe asset resolution, content types, caching
src/rubric.ts         the band descriptors, index = band
src/tasks.ts          Writing Task 2 questions to show
src/ielts.ts          code-owned rules: word count, half-band rounding, warnings
src/typesafe.ts       HTTP client for the evaluation API, with retry and backoff
src/evaluate.ts       question design, one request, composition into a report
frontend/app.ts       browser code (bundled into public/app.js)
public/               the built site: index.html, styles.css, app.js, favicon.svg
src/*.test.ts         bun test
nixpacks.toml         build plan for Dokploy
```

## Tests

```bash
bun run check     # typecheck, then the test suite
bun test
bun run typecheck
```

The suite covers the deterministic half of the app: the descriptor tables, half-band
rounding, the overall band, the length and confidence rules, the exact request body sent
upstream, and that a missing criterion answer fails loudly instead of being reported as a
guess. It also covers the guards — client address selection, window and daily limits,
body size enforcement, traversal and dotfile rejection, extension allow-listing, and the
security headers — plus two regression tests for the product rules: visitor-facing copy
does not name the model outside the footer, and the page contains no inline script, so the
strict content policy cannot break it.

## Notes and limits

- The bands are model estimates for practice and feedback. They are not an official IELTS
  result and not a substitute for a trained examiner.
- Thresholds live in `src/ielts.ts` as named constants: `LOW_CONFIDENCE` (0.5) flags a
  criterion whose answer is spread across bands, and `MEMORISED_THRESHOLD` (0.8) flags a
  memorised response. They are starting points, not validated cut-offs — tune them against
  answers with known grades.
- A Score's confidence describes the shape of its own distribution, not whether the band is
  correct. The app treats low confidence as "read this one carefully", not as an error.
- The band descriptors are the public version. Coherence and Cohesion, Lexical Resource and
  Grammatical Range and Accuracy are blank at band 0 on the official sheet; the app says so
  instead of inventing a descriptor.
- The questions in `src/tasks.ts` are representative Task 2 questions written for this
  project, not past exam papers.
- Rate limits key on the client address and are held in memory, so they assume a single
  container. Running several replicas would make the per-address limits approximate; the
  daily ceiling would also become per replica. If you need exact limits across replicas,
  move the counters into a shared store.