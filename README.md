# YUKTI Agent

Agentic workflow control center for Test Orbit. Operators pick a pre-planned workflow card. An agent then works through it in three stages:

- **Observe:** reads the live system through MCP tools.
- **Reason:** turns what it found into findings and a recommendation.
- **Act:** carries out the change, pausing for a human decision before any action that affects candidates.

Every tool call is a **real** call to the Test Orbit admin API, made **as the signed-in admin**. Test Orbit's roles, validation, row locks and audit log therefore all apply, exactly as if the admin had clicked through the console. Nothing is simulated.

---

## Architecture

```
Browser (React 18) ──cookie session──►  YUKTI server :3002 (Express 5)
                                          │
                                          ├─ /api/auth      sign in with a Test Orbit admin account
                                          ├─ /api/workflows workflow catalogue (+ availability from tools/list)
                                          ├─ /api/runs      start · SSE event stream · approve/reject · cancel · artifacts
                                          │       │
                                          │   Agent engine ──JSON-RPC 2.0 (Bearer operator token)──┐
                                          │                                                         ▼
                                          └─ /mcp, /mcp/{questions|candidates|proctoring|analytics}  MCP server (25 tools)
                                                                                                    │
                                                                                      Test Orbit admin REST API (as the operator)
```

| Layer | Where | Notes |
| :--- | :--- | :--- |
| MCP server | [`server/mcp/`](server/mcp) | Streamable HTTP (JSON responses), protocol `2025-06-18` (also accepts `2025-03-26` and `2024-11-05`). Tools carry MCP annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`). Input is validated with Zod; the published JSON Schema is generated from the same schema. Tool failures come back as `isError` results (per spec), so the agent can reason about them. |
| Tools | [`server/mcp/tools/`](server/mcp/tools) | Each tool is a thin, typed adapter over one or two Test Orbit admin endpoints. No database access. Outputs never include answer keys or personal email. |
| Agent engine | [`server/agent/engine.ts`](server/agent/engine.ts) | Run state machine. Steps pass data to each other through the run context. Supports conditional steps, per-item loops (`forEach`) and pure reasoning steps. Read tools are retried once; writes never. Supports cancellation and a bounded in-memory store. |
| Workflows | [`server/agent/workflows/`](server/agent/workflows) | Declarative plans. The reasoning in each is a pure function and is unit-tested. |
| UI | [`src/`](src) | Workflow cards, execution studio, step DAG, live JSON-RPC console, approval modal, run summary. |

### Human-in-the-loop, enforced on the server

A tool marked `requiresApproval` in the registry **never executes** until the run's owner approves it in the UI. A workflow definition cannot opt out of this.

- **Gated tools:** `approve_reentry_request`, `terminate_session`, `activate_paper`, `assign_student_domain`, `evaluate_coding_answer` and `export_results_csv`.
- **What the approver sees:** the agent's assessment (evidence and recommendation), any long material such as the candidate's code, and the exact JSON-RPC arguments.
- **What the approver can change:** only the fields the workflow declares editable. The approval endpoint ignores anything else, and the tool validates the input again.
- **Expiry:** an approval auto-rejects after 30 minutes.

## Workflows

| Card | Tool chain (🔒 = approval gate) | Reasoning |
| :--- | :--- | :--- |
| ⚡ Candidate Outage & Re-entry Approval | `search_students` → `list_reentry_requests` → `get_proctoring_events` → 🔒`approve_reentry_request` | Refuses ambiguous candidates. Separates a genuine outage from a policy termination. Warns when Test Orbit would refuse for lack of remaining time. |
| 📝 Question Paper Assembly & Readiness | `list_domains` → `get_question_pool` → `search_questions` → `create_paper` → `validate_paper_readiness` → 🔒`activate_paper` | Fits the `A:10, B:5` section plan to the eligible pool. Dry-run draw before activation. |
| 📊 Coding Evaluation Queue | `get_unevaluated_submissions` → `get_coding_answers_for_review` → 🔒`evaluate_coding_answer` ×n → `finalize_session_score` → `recalculate_attempt_percentiles` | One gate per answer; the **reviewer enters the marks**, so the agent never invents them. |
| 🛡️ Candidate Identity, Education & Device Audit | `search_students` → `get_student_profile` → `get_device_check_logs` → 🔒`assign_student_domain` (if requested) | Checks education levels and chronology, identity photo, and camera/microphone problems. |
| 🚨 Live Proctoring Incident Triage | `list_active_sessions` → `get_proctoring_events` ×n → 🔒`terminate_session` (if over threshold) | Transparent severity weights. Otherwise it stops and recommends continued monitoring. |
| 📈 Placement Analytics & Scorecard Export | `get_dashboard_metrics` → `generate_domain_report` → `recalculate_attempt_percentiles` → `generate_candidate_scorecard` → 🔒`export_results_csv` | Flags provisional results (pending coding review). The CSV is kept only in the run. |

**Not built, deliberately.** These items from the original brief have no backing capability in Test Orbit and are not faked:

- `issue_candidate_warning`: Test Orbit has no admin-to-candidate messaging. Candidates already get automatic on-screen warnings from the proctoring rules.
- `register_student`: registration is the candidate's own step, with consent, device check and photo.
- `extend_session_time`: time can only be adjusted through a re-entry approval.

Adding any of them first needs the feature in Test Orbit itself.

## Run locally

```bash
cd yukti-agent
npm install
cp .env.example .env        # TESTORBIT_API_URL → your Test Orbit (e.g. http://localhost:4000)
npm run dev                 # UI http://localhost:5174 · API/MCP http://localhost:3002
```

Sign in with a Test Orbit admin account. Accounts that still have to change their initial password are refused; change it in the Test Orbit console first. Read-only steps work for REVIEWER accounts, but Test Orbit enforces ADMIN for the gated actions.

| Command | |
| :--- | :--- |
| `npm test` | Unit tests (engine policies, reasoning functions) and end-to-end tests: the real YUKTI server against a stub Test Orbit API over HTTP, covering login, the MCP protocol, approval gates, argument editing, rejection, ambiguity, per-item gates and SSE. |
| `npm run typecheck` | Client, server and tests. |
| `npm run build` | Typecheck, then Vite build (`dist/`), then server build (`dist-server/`). |
| `npm start` | Production server; serves the built UI. |

### Calling the MCP server from another client

```bash
# live check (no auth)
curl http://localhost:3002/mcp/proctoring
# JSON-RPC (Bearer = an operator session token; the engine uses the run owner's)
curl -X POST http://localhost:3002/mcp -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## Deploy (Railway)

Create a **separate service** with root directory `yukti-agent/`; [`railway.json`](railway.json) builds and starts it. Set these variables:

- `NODE_ENV=production`
- `TESTORBIT_API_URL=https://<test-orbit-domain>`
- `APP_ORIGIN=https://<yukti-domain>`
- `TRUST_PROXY=1`

Run **one replica**: operator sessions and runs are kept in memory by design. A restart ends them, and operators simply sign in again.

## Security model

- **Credentials.** Operators sign in with their own Test Orbit admin account; there is no shared service account. The Test Orbit session cookie stays on the YUKTI server. The browser holds an opaque `HttpOnly`, `SameSite=Strict` cookie, which is `__Host-` prefixed in production.
- **Requests.** A CSRF header plus an Origin check apply on every write. MCP POSTs require a Bearer token and an Origin check (DNS-rebinding defence).
- **Scope.** Runs are visible only to their owner. Approvals can be decided only by the owner, and only editable fields can change.
- **Limits.**
  - Sign-in is rate-limited; Test Orbit additionally locks accounts after repeated failures.
  - Console payloads are truncated (6 KB).
  - CSV artifacts are capped at 15 MB, served `no-store` and only to the run's owner.

## Relation to `skillui/` and `mcp-servers/`

Those folders hold an earlier MCP **mock-up**. Their tool calls return canned data (for example a random `ORBIT-1234-RESUME` code that Test Orbit would reject) and they have no authentication. YUKTI does not use them. Its MCP endpoints at `/mcp/*` are a working replacement, backed by the real API.
