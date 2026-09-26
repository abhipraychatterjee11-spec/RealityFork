# RealityFork

**Team:** TripleT  
**Hackathon track:** Web3  
**Project statement:** RealityFork is a version-control and verification layer for disputed public records, preserving competing observations, their evidence and their lineage without pretending that software can automatically decide truth.

## 1. Project identity

RealityFork addresses a practical civic-data problem: a public record can say one thing while citizens, officials or sensors observe something different. A road may be recorded as being in good condition even though recent photographs show damage. Conventional databases often overwrite the old value or hide how a decision was reached. RealityFork keeps each observation as a separate, content-addressed record and preserves the disagreement until a review process resolves it.

The focused MVP use case is **disputed urban road-condition reporting in India**. The intended flow is:

1. An official publishes an observation about a road.
2. A citizen submits contradictory evidence as a fork.
3. Reviewers inspect the evidence and challenge weak or misleading claims.
4. A reviewed merge records the resolution without erasing either branch.
5. Compact hashes and lineage can later be anchored to an EVM registry.

This matters because citizens need a way to show that evidence existed at a particular point in a public decision process, while public bodies need a reviewable history rather than an unauditable stream of accusations. The same model could eventually apply to other public infrastructure, but those broader uses are not part of the current MVP.

RealityFork does **not** claim to determine objective truth, authenticate every photograph, replace municipal governance, identify a wallet holder's legal identity, or make an `official`/`reviewer` role trustworthy merely because it was signed. It currently does not upload files, persist records to PostgreSQL, submit blockchain transactions or provide a wallet UI.

## 2. Core concept

- **RealityCommit:** a versioned observation containing a claim, evidence commitment, author claim and zero to two parent commit hashes. The implemented V1 byte format is frozen and documented in [the integrity specification](docs/integrity-spec.md).
- **Evidence graph:** the collection of commits and parent-child relationships that shows how observations evolved. The database schema can represent this graph; the frontend currently shows cards and parent counts rather than a full graph.
- **Fork:** a commit with one parent that preserves a competing observation instead of overwriting the parent.
- **Challenge:** a versioned, signed objection to a target commit. The API stores challenges in memory, while the hardened contract can anchor them through an authorized relayer; the two are not integrated.
- **Reviewed merge:** a proposed two-parent resolution that retains both branches. The contract enforces reviewer-only signed merges and supersedes both parents atomically, but the API review/merge workflow is not complete.
- **Reality Diff:** the intended field-level comparison between branches. The current dashboard labels its view “Reality Diff” but does not yet calculate or render a detailed diff.
- **Time-travel history:** chronological retrieval of all commits for a subject through the history API. Durable history requires the planned Prisma repository.
- **On-chain anchor:** a compact blockchain record containing hashes and lineage. The Solidity registry exists, but no deployment or API chain adapter exists yet.
- **Off-chain evidence:** media, documents, metadata and reviewer notes kept outside the blockchain for cost, privacy and lawful-removal reasons. Object-storage services are configured locally but not integrated.
- **Claimant:** the person or organization making an observation.
- **Signer:** the wallet proving control of a key and authorizing exact EIP-712 data.
- **Uploader:** the client or service transferring evidence bytes; it need not be the claimant.
- **Relayer:** a future backend service that may submit an authorized hash to a chain. A relayer is not the claimant.
- **Reviewer:** a future authorized party that evaluates challenges and merges. The present `authorRole` field is only a signed claim, not authorization.
- **Registry administrator:** the contract's OpenZeppelin `DEFAULT_ADMIN_ROLE`, responsible for granting and revoking relayer/reviewer roles. Production governance is not designed or deployed.

RealityFork deliberately preserves disagreement. Blockchain ordering, signatures, evidence scores, AI-risk signals and source reputation may help reviewers inspect a claim, but none of them automatically makes a claim true or false.

## 3. Why Web3 is used

Web3 is useful here as a shared verification boundary, not as a payment or speculation mechanism. A blockchain can timestamp compact commitments and make later silent edits detectable. EIP-712 allows a wallet to authorize an exact commit for one chain, registry address, nonce and expiry. The smart contract can eventually enforce basic registry state transitions, while large and sensitive evidence remains off-chain.

RealityCommits are **verifiable digital records, not tradeable tokens**. The repository contains no token, NFT, marketplace or cryptocurrency feature.

| Component | Where it runs | What it stores | Why it is needed | What it does not prove |
|---|---|---|---|---|
| React dashboard | Browser | Displayed API state | Lets citizens and reviewers inspect commits | That displayed claims are true |
| Fastify API | Backend | Current in-memory commits, challenges and nonces | Validates schemas, hashes, signatures and workflow requests | Durable persistence or independent decentralization |
| Canonical hashing | Shared TypeScript | Deterministic bytes and SHA-256 digests | Makes the same logical record hash identically | Authenticity of the real-world observation |
| Evidence Merkle root | Shared TypeScript | Root of committed evidence metadata | Detects committed evidence changes and supports future proofs | That the referenced file is genuine or currently available |
| EIP-712 signature | Wallet and API | Public authorization signature and domain metadata | Proves wallet control and binds authorization to a nonce/domain | Legal identity, official status or truth |
| Nonce repository | API memory | Used nonce per signer | Stops replay during one API process lifetime | Protection across restarts or multiple servers |
| PostgreSQL schema | Prisma/PostgreSQL design | Commits, edges, evidence and challenges | Defines planned durable searchable state | Persistence today; the API does not use it yet |
| MinIO | Local Docker service | Intended evidence files | Provides S3-compatible off-chain storage | Content integrity until upload hashing is implemented |
| `RealityRegistry` | EVM contract source | Commit/evidence hashes, lineage, author/relayer/reviewer, status, nonce/challenge replay state and events | Enforces signed, role-gated registry transitions | Truth, file availability or real-world identity/governance quality |
| Relayer | Planned backend component | Transaction requests and receipts | Could submit signed records without exposing claimant keys | That `msg.sender` is the claimant |

## 4. Current implementation status

Status reflects the repository as it exists now.

| Capability | Status | Repository evidence and limitation |
|---|---|---|
| Canonical RealityCommit V1 hashing | Complete | Recursive canonical JSON, UTC normalization and SHA-256 are implemented in [`packages/shared/src/integrity.ts`](packages/shared/src/integrity.ts). |
| Evidence Merkle root | Complete | Deterministic sorted leaves, raw-byte parent hashing and odd-node duplication are implemented. Actual uploaded file bytes are not yet verified. |
| Golden vectors | Complete | Fixed leaf, root, commit, fork and merge hashes are tested in [`apps/api/test/integrity.test.ts`](apps/api/test/integrity.test.ts). |
| API | In progress | Fastify health, listing, creation, fork, challenge and history routes exist; state remains in memory. |
| Commit creation | Complete | Signed and explicitly enabled unsigned in-memory creation work. |
| Fork creation | Complete | Parent UUIDs are resolved to canonical parent commit hashes before hashing. |
| Challenge flow | In progress | Signed/unsigned challenge creation works in memory; listing, review, resolution and on-chain anchoring do not. |
| Signature verification | Complete | EIP-712 commit/challenge recovery, domain checks, identity checks and expiry checks are implemented. |
| Replay protection | In progress | Correct per-signer in-memory protection exists, but it resets on restart and is not safe for multiple instances. |
| Frontend dashboard | In progress | React displays commit cards, counts and errors. It has no capture, upload, wallet, branch graph or detailed diff UI. |
| Database schema | In progress | Prisma models commits, evidence, challenges and edges. It lacks migrations and newer signature/nonce/chain-lifecycle fields. |
| Persistent database repository | Planned | The API still uses `MemoryRealityStore`. |
| Object-storage upload | Planned | Docker Compose provides MinIO, but there is no client, upload endpoint or byte-hash verification. |
| AI-forensics integration | Planned | The API accepts a caller-supplied `aiRiskScore`; it runs no forensic model. |
| Smart-contract hardening | Complete locally | AccessControl roles, frozen EIP-712 verification, on-chain replay protection, expiry, lineage/status rules and 12 Hardhat scenarios are implemented. No external audit has occurred. |
| Contract deployment | Planned | No deployment script, deployed address manifest or verified network deployment exists. |
| Blockchain adapter | Planned | No API transaction submission, retry, receipt or event-reconciliation code exists. |
| Wallet UI | Planned | No frontend signing or wallet connection exists. |
| Explorer links | Planned | `chainTxHash` is modeled but is not populated or displayed. |
| Reviewer authorization | Partial | The contract has an administrator-managed reviewer allowlist; API `authorRole` values remain self-asserted and no institutional credential/governance process exists. |
| End-to-end testing | In progress | API-level hashing/signature tests exist; browser, storage and chain flows are not integrated. |
| Tokens, NFTs or payments | Not in MVP | They do not improve the civic-record workflow and are not implemented. |

## 5. Architecture

### Current and planned system

Solid arrows are implemented paths. Dashed arrows are planned integrations.

```mermaid
flowchart LR
  Citizen[Citizen or official] --> Web[React dashboard]
  Web -->|GET commits| API[Fastify API]
  Client[API client or test wallet] -->|Signed EIP-712 request| API
  API --> Shared[Canonical hashing, Merkle root and signature helpers]
  API --> Memory[(In-memory store and nonce set)]
  API -.-> Postgres[(PostgreSQL via Prisma)]
  API -.-> MinIO[(MinIO object storage)]
  API -.-> Relayer[Transaction adapter / relayer]
  Relayer -.-> Registry[RealityRegistry contract]
  Registry -.-> Explorer[Explorer proof]
  Explorer -.-> Web
```

### Target citizen-submission sequence

The current repository implements validation, canonical hashing, signature verification and in-memory storage. Upload, durable storage, relaying and proof display are planned.

```mermaid
sequenceDiagram
  actor Citizen
  participant Web as React UI
  participant Files as Object storage
  participant API as Fastify API
  participant DB as PostgreSQL
  participant Relayer
  participant Chain as RealityRegistry

  Citizen->>Web: Capture claim and evidence
  Web-->>Files: Planned: upload evidence bytes
  Files-->>Web: Planned: immutable URI and verified digest
  Web->>Web: Build canonical commit and EIP-712 message
  Citizen->>Web: Sign in wallet
  Web->>API: Signed source input and authorization
  API->>API: Rebuild root/hash; verify domain, signer, expiry and nonce
  API->>DB: Planned: transactionally store record and consume nonce
  Note over API: Current MVP stores both in memory
  API-->>Web: Commit plus integrity identifiers
  API-->>Relayer: Planned: enqueue anchor
  Relayer-->>Chain: Planned: submit commit hash, root and parents
  Chain-->>Relayer: Planned: receipt and event
  Relayer-->>DB: Planned: reconcile confirmation
  Web-->>Citizen: Planned: proof state and explorer link
```

### On-chain versus off-chain data

| On-chain design | Off-chain design |
|---|---|
| Commit hash | Claim text and searchable fields |
| Evidence root | Original media and documents |
| Up to two parent commit hashes | Precise or approximate location |
| Transaction sender and chain timestamp | Claimant authorization signature metadata |
| Registry status and events | Challenges, reviewer notes and moderation data |
| Challenge/merge event hashes | AI-risk and evidence-strength review signals |

No on-chain integration is currently connected to the running API.

### Trust boundary, privacy and false claims

The browser and uploader are untrusted inputs. The API must independently validate schemas, recalculate hashes and verify signatures. Object storage will remain outside the chain so access control, encryption, consent, redaction, retention and lawful removal remain possible. A public hash can still create privacy risk if it is linked to identifying metadata, so raw locations and wallet-to-person mappings should not be published by default.

Suspicious or AI-generated media should be challengeable evidence, not automatically rejected truth. The implemented score is a triage signal. Production controls should combine verified file hashing, C2PA where available, capture metadata, device attestation, duplicate-media detection, nearby corroboration and human review. See [the security notes](docs/security.md).

## 6. Repository map

| Path | Owner | Purpose and important files | Connection |
|---|---|---|---|
| [`apps/web`](apps/web) | Mainak Som | React/Vite dashboard. [`App.tsx`](apps/web/src/App.tsx) fetches and renders commits; [`styles.css`](apps/web/src/styles.css) defines the present UI. | Reads the API and shared `RealityCommit` type. |
| [`apps/api`](apps/api) | Soumyanil Halder | Fastify application, in-memory store, scoring, authorization and nonce handling. [`app.ts`](apps/api/src/app.ts) defines routes; [`server.ts`](apps/api/src/server.ts) starts the service. | Consumes shared schemas/integrity helpers; future home of Prisma, MinIO and chain adapters. |
| [`apps/api/test`](apps/api/test) | Soumyanil with Abhipray review for integrity tests | API, canonical hashing, scoring, signature and replay tests. | Protects cross-team behavior and frozen vectors. |
| [`packages/shared`](packages/shared) | Abhipray for integrity/signatures; shared review by all | Zod schemas and shared types in [`index.ts`](packages/shared/src/index.ts), frozen commitment logic in [`integrity.ts`](packages/shared/src/integrity.ts), EIP-712/challenge helpers in [`signatures.ts`](packages/shared/src/signatures.ts). | Must be consumed by backend and frontend rather than reimplemented incompatibly. |
| [`packages/contracts`](packages/contracts) | Abhipray Chatterjee | Hardened Solidity registry, Hardhat configuration/tests and [contract operating notes](packages/contracts/README.md). | Future target of the relayer/adapter; currently disconnected from the API. |
| [`packages/database`](packages/database) | Soumyanil Halder | Prisma/PostgreSQL design in [`schema.prisma`](packages/database/prisma/schema.prisma). | Planned replacement for the in-memory store. |
| [`docs`](docs) | All teammates; domain owners review their sections | Architecture, security, demo and implementation plans. | Normative formats live in [`integrity-spec.md`](docs/integrity-spec.md) and [`identity-and-signature-spec.md`](docs/identity-and-signature-spec.md). |
| [`.env.example`](.env.example) | Soumyanil and Abhipray | Safe local variable template. Values are examples, not production secrets. | Documents API, database, storage and signature configuration. |
| [`docker-compose.yml`](docker-compose.yml) | Soumyanil Halder | Local PostgreSQL 17 and MinIO services. | Services are optional because the API does not yet use them. |
| [`pnpm-workspace.yaml`](pnpm-workspace.yaml) | All teammates | Workspace package discovery and allowed native dependency builds. | Controls monorepo installation behavior. |

Generated `dist`, Hardhat `artifacts`/`cache`, coverage, `.env` and `node_modules` content must not be committed.

## 7. Local setup on Windows

### Prerequisites

- Node.js 22, matching [`.nvmrc`](.nvmrc).
- pnpm 11.19.0, matching the root `packageManager` field.
- Docker Desktop only if running PostgreSQL and MinIO.
- A browser wallet only for future/manual signing UI work; current automated tests generate ephemeral wallets.

From PowerShell in the repository root:

```powershell
node --version
corepack enable
corepack prepare pnpm@11.19.0 --activate
pnpm --version
Copy-Item .env.example .env
pnpm install --frozen-lockfile
```

Review every requested dependency build before approving it. The workspace currently permits only Prisma engines/client, Prisma and esbuild. If pnpm asks for approval after a dependency change:

```powershell
pnpm approve-builds
```

Approve only dependencies the team intentionally added. Never approve an unfamiliar package simply to suppress an error.

### Environment loading

The current API reads `process.env`; it does **not** automatically load the root `.env` file. Copying `.env.example` is useful as a local reference, but set required variables in the same PowerShell session before starting services. For the unsigned local demo:

```powershell
$env:ALLOW_UNSIGNED_DEMO_MODE = "true"
$env:SIGNATURE_CHAIN_ID = "31337"
$env:REGISTRY_CONTRACT_ADDRESS = "0x1000000000000000000000000000000000000001"
pnpm dev
```

The registry address above is a dummy domain value, not a deployed contract. Do not use it in a real environment.

Open `http://localhost:5173`; the API defaults to `http://localhost:4000`.

Useful commands:

```powershell
pnpm dev                 # Build shared, then start API and web watchers
pnpm dev:api             # API only; shared must already be built
pnpm dev:web             # Web only; shared must already be built
pnpm typecheck           # All workspace type checks
pnpm test                # All workspace test scripts
pnpm build               # All workspace builds
pnpm contracts:compile   # Current contract compile command
pnpm contracts:test      # Current contract test command
```

Optional infrastructure:

```powershell
docker compose up -d
docker compose ps
pnpm --filter @realityfork/database typecheck
```

PostgreSQL listens on `5432`; MinIO uses `9000` and its console uses `9001`. Starting them does not make the API persistent because adapters are not implemented.

### Common setup problems

| Problem | Cause | Fix |
|---|---|---|
| Wrong pnpm version | Global pnpm differs from `packageManager` | Run `corepack prepare pnpm@11.19.0 --activate`. |
| Ignored Prisma/esbuild scripts | Build approval was not granted or workspace trust changed | Inspect packages, then run `pnpm approve-builds`; never approve unknown dependencies. |
| API rejects unsigned curl with `403` | Secure default has unsigned mode disabled | Set `ALLOW_UNSIGNED_DEMO_MODE=true` only for the local demo. |
| Signed route returns `SIGNATURE_CONFIGURATION_MISSING` | Chain ID or registry address is absent | Set `SIGNATURE_CHAIN_ID` and `REGISTRY_CONTRACT_ADDRESS` in the process environment. |
| Frontend says API unavailable | API is not running or `VITE_API_URL` is wrong | Start the API and set `VITE_API_URL` before Vite starts. |
| Data disappears | Current store is in memory | Expected MVP behavior; implement the Prisma repository. |
| Hardhat cannot download a compiler | Network access or the compiler cache is unavailable | Restore network access for the first compile, then retry `pnpm contracts:compile`; do not claim a pass without output. |
| Prisma cannot find its schema | Command was run from the monorepo root with a direct Prisma binary | Use the package script or pass `--schema packages/database/prisma/schema.prisma`. |

## 8. Environment variables

| Variable | Example safe value | Used by | Required or optional | Meaning | Security note |
|---|---|---|---|---|---|
| `PORT` | `4000` | API | Optional | HTTP listening port | Avoid exposing development servers publicly. |
| `VITE_API_URL` | `http://localhost:4000` | Web | Optional locally | API base URL compiled into the frontend | Values prefixed `VITE_` are public; never place secrets in them. |
| `DATABASE_URL` | `postgresql://realityfork:realityfork@localhost:5432/realityfork` | Prisma | Required for Prisma commands; adapter planned | PostgreSQL connection string | Production credentials belong in a secret manager. |
| `OBJECT_STORE_ENDPOINT` | `http://localhost:9000` | Planned API adapter | Optional today | S3-compatible endpoint | Use TLS and restricted network access in production. |
| `OBJECT_STORE_BUCKET` | `realityfork-evidence` | Planned API adapter | Optional today | Evidence bucket | Apply retention and access policies. |
| `OBJECT_STORE_ACCESS_KEY` | `realityfork` | Planned API adapter | Optional today | Local MinIO access identifier | Not secret by itself, but should still be scoped. |
| `OBJECT_STORE_SECRET_KEY` | `change-me` | Planned API adapter | Optional today | Local MinIO secret | Replace outside local development; never commit real values. |
| `CHAIN_RPC_URL` | `http://127.0.0.1:8545` | Hardhat config; future adapter | Optional today | EVM JSON-RPC endpoint | Provider URLs may include credentials; protect them. |
| `SIGNATURE_CHAIN_ID` | `31337` | API signature verifier | Required for signed routes | EIP-712 domain chain ID | Must match the network intended for the registry. |
| `REGISTRY_CONTRACT_ADDRESS` | `0x1000000000000000000000000000000000000001` | API signature verifier | Required for signed routes | EIP-712 verifying-contract domain | Example is a dummy; use an address manifest after deployment. |
| `ALLOW_UNSIGNED_DEMO_MODE` | `false` | API | Optional; defaults false | Enables legacy unsigned writes | Set true only for a controlled local demo. |
| `PRIVATE_KEY` | empty | Not consumed by current code; reserved in template | Not required | Potential future relayer/deployment credential | Do not put real keys in committed `.env`; rename/scope when relayer work begins. |

## 9. Development phases

### Hackathon MVP phases

| Phase | Goal | Owner | Inputs | Deliverable | Acceptance criteria | Dependencies |
|---|---|---|---|---|---|---|
| 1. Project setup and shared schema | Establish monorepo, validation and local services | Soumyanil, reviewed by all | Use case and field definitions | Runnable workspace and Zod schemas | Clean install, API health route, shared typecheck | None |
| 2. Canonical hashing and evidence root | Freeze deterministic integrity identifiers | Abhipray | Shared evidence/claim types | RealityCommit V1 and Merkle root | Golden vectors pass across reordered inputs | Phase 1 |
| 3. Signature and replay protection | Prove wallet authorization without private-key transfer | Abhipray with Soumyanil integration | Frozen hashes and registry domain | EIP-712 verification and nonce repository | Valid, mutation, expiry, replay and wrong-domain tests pass | Phase 2 |
| 4. Smart-contract hardening | Define enforceable registry state transitions | Abhipray | Integrity/signature specs and threat model | Tested contract with authorization decisions documented | Duplicate, parent, merge, challenge and permission tests pass | Phases 2–3 |
| 5. Deployment and ABI/address manifest | Produce reproducible network artifacts | Abhipray | Hardened contract and selected testnet | Deployment script, ABI and per-chain manifest | Clean deployment, verified address, recorded transaction | Phase 4 |
| 6. Database and object-storage integration | Make records and evidence durable | Soumyanil | Prisma schema, MinIO, integrity helpers | Migrations, repository, verified uploads and durable nonces | Restart-safe API; stored bytes match digest; transactional replay protection | Phases 1–3 |
| 7. Blockchain adapter and transaction lifecycle | Submit and reconcile anchors safely | Soumyanil with Abhipray review | ABI, address manifest and persistent outbox | Pending/submitted/confirmed/failed/reorg states | Idempotent retries and event reconciliation demonstrated | Phases 5–6 |
| 8. Frontend claim capture and Reality Diff | Enable understandable citizen interaction | Mainak | Stable API contracts and signing helpers | Capture, upload, wallet signing, diff and branch views | Mobile-friendly happy path with loading/error states | Phases 3, 6–7 interfaces |
| 9. Challenge and reviewed merge flow | Complete dispute review | Soumyanil backend, Mainak UI, Abhipray security review | Role policy, branch data and contract rules | Challenge queue, authorized merge and preserved lineage | Unauthorized review rejected; two-parent resolution visible | Phases 4–8 |
| 10. Testing, demo rehearsal and submission | Produce a reliable, honest demonstration | All teammates | Integrated vertical slice | Test report, fallback assets and submission | Clean-machine rehearsal; claims match implementation | All prior phases |

### Production roadmap

1. Define municipal governance, appeals, lawful-removal and reviewer-accountability rules.
2. Add verified reviewer/official credentials and multi-party merge authorization.
3. Persist nonces, authorization metadata and commit creation in one database transaction.
4. Encrypt sensitive evidence, separate public and restricted metadata, and audit every access.
5. Validate actual uploaded bytes, add malware scanning, retention policies and redundant storage.
6. Verify C2PA manifests where available and add calibrated forensic risk signals without treating them as truth.
7. Add immutable audit logs, relayer monitoring, key rotation and incident response.
8. Run a limited public pilot with one consenting municipal workflow and independent security/privacy review.
9. Measure throughput, storage cost, review latency and false-positive rates before scaling.

## 10. Team roles and handoff rules

### Soumyanil Halder — Backend lead

**Ownership:** API, database, Prisma persistence, evidence ingestion, file hashing, object storage, review workflow, backend integration, difficult technical implementation and backend testing.

**Primary files:** `apps/api/**`, `packages/database/**`, `docker-compose.yml`, backend portions of `.env.example`; shared schemas only through coordinated review.

**Depends on:** Abhipray's frozen hash/signature interfaces and contract artifacts; Mainak's agreed request/response and UX requirements.

**Must not change without team agreement:** canonical V1 fields/bytes, EIP-712 type/domain, public API breaking changes, role/governance policy, contract addresses or secret-handling policy.

**Definition of done:** migrations and repositories are transactional; file bytes are independently hashed; nonces survive restart; API errors are stable; storage/chain jobs are idempotent; failure paths are tested.

**Required tests:** repository integration, API injection, upload hash mismatch, transaction rollback, nonce races, authorization failures, object-store failure and chain outbox retries.

**Handoff checklist:** publish migrations, API schema/examples, error codes, fixtures, environment changes and test output; tell Mainak what is stable; ask Abhipray to review every integrity boundary.

**Questions before integration:** Which fields are frozen? Which chain states must be displayed? What upload progress/errors does the UI need? What reviewer permissions are approved?

### Mainak Som — Frontend lead

**Ownership:** React interface, claim capture, evidence-submission UI, Reality Diff, branch visualization, dashboard, user experience, accessibility, loading/error states and demo screens.

**Primary files:** `apps/web/**`; frontend-facing examples or screenshots in `docs/**` with review.

**Depends on:** Soumyanil's API/upload contracts and Abhipray's exported signing/canonical helpers and address manifest.

**Must not change without team agreement:** canonical hashing/signature formats, backend validation rules, chain status meanings, role policy or privacy defaults.

**Definition of done:** a citizen can understand claim state, sign safely, see upload/transaction progress, compare branches and recover from errors without exposing precise data unintentionally.

**Required tests:** component behavior, API mocks, wallet rejection, wrong-network handling, loading/error/empty states, responsive layout, accessibility and an end-to-end happy path when backend endpoints stabilize.

**Handoff checklist:** document screens and API assumptions; provide reproducible UI steps and screenshots; surface every backend error code; request privacy and Web3 review before demo freeze.

**Questions before integration:** Which inputs are server-derived? Which domain will the wallet display? Which transaction states exist? Which location fields may be public? What is the offline/fallback behavior?

### Abhipray Chatterjee — Web3 integrity lead

**Ownership:** canonical commitment rules, Merkle evidence roots, EIP-712 signatures, nonce-protection requirements, Solidity contracts, deployment, blockchain adapter requirements, on-chain verification and Web3 security review.

**Primary files:** `packages/shared/src/integrity.ts`, `packages/shared/src/signatures.ts`, `packages/contracts/**`, `docs/integrity-spec.md`, `docs/identity-and-signature-spec.md`; integrity-related API tests jointly with Soumyanil.

**Depends on:** Soumyanil for verified bytes, durable transactions and relaying; Mainak for correct wallet prompts, network selection and proof presentation.

**Must not change without team agreement:** frozen RealityCommit V1 or Evidence V1 rules, EIP-712 domain/type version, deployed contract behavior/address, migration policy or reviewer governance.

**Definition of done:** golden vectors remain stable; contract invariants and access rules are tested; deployment is reproducible; adapter requirements cover confirmations/reorgs; explorer proofs map back to canonical hashes.

**Required tests:** golden vectors, mutations, domain/replay/expiry, contract unit/fuzz/invariant tests, deployment smoke test and backend/frontend cross-language vectors.

**Handoff checklist:** publish ABI, address manifest, chain ID, deployment transaction, typed-data examples, threat model and expected adapter states; clearly distinguish claimant from relayer.

**Questions before integration:** Are uploaded bytes verified? Is nonce consumption transactional? Which wallet signs and which account relays? Who may merge? How are reorgs and replaced transactions represented?

### Cross-team contracts

- Backend must consume shared canonical hashing and signature helpers.
- Frontend must not create incompatible hash or signature formats; it should import or reproduce published vectors exactly.
- Web3 must not change frozen V1 commitment rules without a new schema version and migration plan.
- Database UUIDs are internal identifiers and must never replace commit hashes in integrity logic.
- AI-risk scores are review signals, never truth judgments.
- Blockchain confirmation proves record anchoring, not real-world truth.
- All teammates own integration, end-to-end testing, presentation, demo rehearsal, documentation review and final submission.

## 11. Role-based Codex and ChatGPT prompt playbooks

### Context to paste before every prompt

```text
RealityFork is TripleT's Web3 hackathon project for disputed urban road-condition records in India. The current stack is React/Vite, Fastify, shared Zod/TypeScript integrity helpers, a Prisma schema, local PostgreSQL/MinIO configuration and a disconnected Solidity registry scaffold. RealityCommit V1 and Evidence V1 hashing are frozen. EIP-712 commit/challenge verification and in-memory per-signer nonces work; PostgreSQL persistence, file upload, wallet UI, deployment and blockchain adapter do not. Preserve disagreement and never claim blockchain, AI or reputation determines truth. Inspect actual code before making claims.
```

### Soumyanil's Backend Prompt

```text
Act as RealityFork's backend implementation partner. First inspect the entire repository, especially apps/api, packages/database, packages/shared, current tests and specifications. Soumyanil Halder owns the API, Prisma persistence, evidence ingestion, byte hashing, object storage, review workflow and difficult backend integration. Preserve frozen RealityCommit V1/Evidence V1 and use the shared hashing/signature helpers rather than reimplementing them. Avoid unrelated frontend or contract changes. Implement the requested backend slice with transactional behavior and clear error handling. Run relevant type checks, API tests and database validation. Report files changed, commands/tests run, limitations and any migration or teammate dependency. Do not claim planned persistence, storage or chain behavior works. Ask approval before public deployment, destructive database actions or secret changes.
```

### Mainak's Frontend Prompt

```text
Act as RealityFork's frontend implementation partner. First inspect the repository, especially apps/web, shared types/helpers, API routes, README and specifications. Mainak Som owns React UX, claim capture, evidence submission, Reality Diff, branch visualization, dashboard, loading/error states and demo screens. Preserve frozen V1 integrity and EIP-712 formats; do not invent client hashes or signatures incompatible with shared vectors. Avoid unrelated backend, database or contract changes. Implement accessible responsive UI against verified API behavior and clearly show pending, failed and unimplemented states. Run frontend typecheck/build and relevant tests. Report files changed, tests run, limitations and backend/Web3 dependencies. Do not claim wallet, upload or chain flows work unless tested. Ask approval before public deployment, destructive actions or secret changes.
```

### Abhipray's Web3 Prompt

```text
Act as RealityFork's Web3 integrity partner. First inspect the repository, integrity/signature specifications, shared helpers, API integration, Solidity source and tests. Abhipray Chatterjee owns canonical commitments, Merkle roots, EIP-712 signatures, replay requirements, contracts, deployment requirements and Web3 security review. RealityCommit V1/Evidence V1 are frozen; any change requires a new version and migration, never an in-place edit. Keep claimant, signer and relayer identities separate. Avoid unrelated backend/frontend changes. Run golden vectors, signature tests and relevant contract checks. Report files changed, exact security assumptions, tests run and integration limitations. Never claim anchoring or deployment occurred without receipts. Ask approval before public deployment, destructive database actions or secret changes.
```

### Shared Integration Prompt

```text
Inspect the complete RealityFork repository before editing. Trace the requested vertical slice through web, API, shared types, database design and Web3 boundaries. Preserve frozen V1 commitment and EIP-712 rules, database-ID/hash separation and the no-automatic-truth principle. Make only coordinated interface changes, add cross-layer tests, and avoid unrelated refactors. Report files changed, contract/API/schema compatibility, tests run, remaining owner handoffs and limitations. Do not overclaim planned features. Ask approval before public deployment, destructive database actions or secret changes.
```

### Bug Investigation Prompt

```text
Diagnose this RealityFork bug using repository evidence before proposing a fix: [describe bug]. Reproduce it, identify the failing layer and compare behavior with the frozen integrity/signature specifications. Do not modify files until the cause is established. Preserve V1 hashes and avoid unrelated changes. If asked to fix it, add a regression test and run the relevant type checks/tests. Report root cause, evidence, files changed, commands run and residual risk. Do not claim untested behavior works. Ask approval before public deployment, destructive database actions or secret changes.
```

### Security Review Prompt

```text
Perform a read-only RealityFork security review. Inspect code and configuration for commitment ambiguity, signature/domain mistakes, replay, role spoofing, upload/hash mismatch, nonce races, relayer compromise, unauthorized merges, privacy leakage and database/chain inconsistency. Treat V1 formats as frozen and recommend versioned migration if necessary. Avoid unrelated edits. Rank findings by severity with exact file references and test recommendations. Report what was actually inspected and all limitations. Do not claim planned controls exist. Ask approval before public deployment, destructive database actions or secret changes.
```

### Demo Preparation Prompt

```text
Inspect the current RealityFork repository and prepare an honest five-minute demo using only working features, with clearly labeled mocks or fallback assets. Preserve frozen V1 rules and avoid unrelated code changes. Verify startup commands, API requests, test output and visible UI states. Include failure fallbacks for RPC, wallet, contract and internet outages. Run relevant tests and report files changed, rehearsal results, missing integrations and claims the presenter must avoid. Ask approval before public deployment, destructive database actions or secret changes.
```

## 12. API and data-model reference

### Routes

| Method | Route | Current behavior |
|---|---|---|
| `GET` | `/health` | Returns API health. |
| `GET` | `/api/commits` | Lists in-memory commits chronologically. |
| `POST` | `/api/commits` | Unsigned root/merge-shaped creation; only with demo mode enabled. Does not implement reviewed merge semantics. |
| `POST` | `/api/commits/:id/forks` | Unsigned one-parent fork; only with demo mode enabled. |
| `POST` | `/api/commits/:id/challenges` | Unsigned in-memory challenge; only with demo mode enabled. |
| `POST` | `/api/signed/commits` | Verifies and creates a signed root or two-parent commit in memory. |
| `POST` | `/api/signed/commits/:id/forks` | Verifies and creates a signed one-parent fork. |
| `POST` | `/api/signed/commits/:id/challenges` | Verifies and stores a signed off-chain challenge. |
| `GET` | `/api/records/:subjectId/history` | Lists in-memory commits for one subject. |

### Signed request lifecycle

1. Strictly validate source input and public authorization envelope.
2. Resolve parent UUIDs to stored commits and extract their commit hashes.
3. Recalculate evidence root and frozen RealityCommit V1 hash.
4. Confirm expiry, chain ID and registry address.
5. Require lowercased `authorId`/`challengerId` to match signer and recovered wallet.
6. Recover the EIP-712 signer using the server-derived hashes.
7. Atomically consume the in-memory signer nonce and create the record.
8. Return the record and stored public authorization metadata.

### RealityCommit V1

| Field | Meaning |
|---|---|
| `schemaVersion` | Fixed `realityfork.commit.v1` |
| `subjectId`, `field`, `value` | Claimed observation |
| `observedAt` | UTC-normalized observation time |
| `locationLabel?` | Optional human-readable location |
| `authorId`, `authorRole` | Claimant identifier and claimed role |
| `message` | Commit explanation |
| `parentCommitHashes` | Zero, one or two integrity parents |
| `evidenceRoot` | Evidence V1 Merkle root |

Database UUID, creation time, scores, moderation state and transaction data are excluded. See [the normative specification](docs/integrity-spec.md).

### Evidence V1 leaf

Committed fields are `schemaVersion`, content `sha256`, `kind`, `uri`, UTC `capturedAt`, and optional `latitude`, `longitude`, `deviceSignature`. Evidence UUID, `aiRiskScore` and derived scores are excluded.

### Challenge V1

Committed fields are `schemaVersion`, `targetCommitHash`, normalized `challenger`, `reason`, `note`, `challengeEvidenceRoot`, nonce and expiry. See [the identity/signature specification](docs/identity-and-signature-spec.md).

### Statuses and rules

- Commit status type: `active`, `challenged`, `merged`, `superseded`.
- The memory store currently assigns only `active` or `challenged`; reviewed merge transitions are incomplete.
- Chain-anchoring statuses such as `pending`, `submitted`, `confirmed`, `failed` and `reorged` are **planned vocabulary**, not current fields or behavior.
- Root commits have zero parent hashes, forks one, and merges exactly two.
- Two merge parents are sorted before hashing; duplicates and malformed SHA-256 digests are rejected.
- Signed nonces are unsigned decimal strings and unique per signer. API enforcement is process-local; the contract independently persists one shared per-signer nonce namespace across commit and challenge authorization types.
- Expiry is Unix seconds; the signature domain must match configured chain and registry.

### Error-code conventions

Implemented signed-mode codes include `UNSIGNED_DEMO_DISABLED`, `SIGNATURE_CONFIGURATION_MISSING`, `CHAIN_ID_MISMATCH`, `INVALID_CONTRACT_ADDRESS`, `CONTRACT_ADDRESS_MISMATCH`, `SIGNATURE_EXPIRED`, `INVALID_NONCE`, `AUTHOR_IDENTITY_MISMATCH`, `CHALLENGER_IDENTITY_MISMATCH`, `INVALID_SIGNATURE` and `NONCE_REPLAY`. Schema-validation responses and some store errors currently return messages without a stable code; Soumyanil should normalize these before frontend integration.

## 13. Security and privacy

| Risk | Current MVP control | Known limitation | Production improvement |
|---|---|---|---|
| Fake evidence | Metadata is committed and mutations change roots | API trusts caller-supplied file digest/URI | Hash received bytes server-side, verify storage and retain upload audit trail |
| AI-generated media | Optional AI-risk score is used only for triage | Score is caller-supplied; no model runs | C2PA verification, calibrated ensemble and human review |
| Metadata spoofing | Capture metadata and device signature can be committed | No device attestation or trusted clock | Trusted capture client, signed timestamps and attestation |
| Wrong-location evidence | Optional coordinates contribute to review signal | Coordinates are self-reported | Consent-aware geofence, device proof and corroboration |
| Replay attacks | API and contract enforce EIP-712 nonce/expiry/domain checks; contract nonces persist on-chain | API nonces reset and do not coordinate across instances; different deployments have independent nonce spaces | Unique database constraint, transactional API consumption and deployed-address discipline |
| Signature misuse | Hash, root, author, domain and expiry are bound | No revocation or compromised-wallet workflow | Key rotation/revocation policy and incident response |
| Relayer compromise | Claimant authorization is separate; contract allowlists relayers and records `msg.sender` | No API relayer/queue exists; an allowlisted relayer can misstate separately supplied lineage arguments | HSM/secret manager, canonical-preimage verification, quotas and monitoring |
| Unauthorized merge | Contract requires `REVIEWER_ROLE`, valid author authorization and two eligible parents | API merge workflow and real-world reviewer credentialing are absent; one reviewer can finalize a merge | Governed role administration, reviewer credentials and multi-party approval if required |
| Reviewer abuse | History is designed to remain visible | No reviewer identity/governance implementation | Rotating panels, appeals and auditable decisions |
| Database/chain inconsistency | Canonical hashes allow comparison | No adapter, receipt model or reconciliation | Transactional outbox, confirmations, reorg handling and event indexer |
| Personal/location privacy | Raw files are intended to remain off-chain | Current schemas allow precise coordinates and wallet identifiers | Consent, precision reduction, encryption, RBAC and retention policy |
| Secrets/private keys | `.env` is ignored; API accepts only public signatures | Template still reserves an unused `PRIVATE_KEY` | Named relayer secret, secret manager, rotation and no frontend exposure |

Never commit `.env`, wallet keys, provider credentials, production database URLs or evidence containing personal data. A blockchain hash is persistent even if the off-chain file is removed.

## 14. Testing and quality gates

| Command | Purpose | Current expectation |
|---|---|---|
| `pnpm --filter @realityfork/shared typecheck` | Shared schemas/integrity/signature types | Must pass |
| `pnpm --filter @realityfork/api typecheck` | API compilation safety | Must pass |
| `pnpm --filter @realityfork/web typecheck` | Frontend type safety | Must pass |
| `pnpm --filter @realityfork/api test` | Scoring, golden vectors, signatures, nonces and route behavior | Must pass all tests |
| `pnpm --filter @realityfork/database typecheck` | Prisma schema validation | Must pass with `DATABASE_URL` defined |
| `pnpm contracts:compile` | Solidity compile | Must pass with Solidity 0.8.28 |
| `pnpm contracts:test` | Role, signature, replay, lineage, transition and event invariants | Must pass all 12 local Hardhat scenarios |
| `pnpm --filter @realityfork/web build` | Production frontend build | Must pass before release |
| Manual root/fork smoke test | Validate API response and parent UUID/hash separation | Must pass with explicit demo mode or valid signatures |

### Manual smoke test

1. Start API/web with explicit environment variables.
2. Confirm `/health` returns `ok: true`.
3. Create a root using a signed request or explicitly enabled local unsigned route.
4. Fork it and confirm `parentIds[0]` is the root UUID while `parentCommitHashes[0]` is its canonical hash.
5. Refresh the dashboard and confirm both cards appear.
6. Submit a challenge and confirm target status becomes challenged.
7. Restart the API and explicitly demonstrate the known loss of memory state.

### Before every Git push

- [ ] No secrets, `.env`, generated artifacts or personal evidence are staged.
- [ ] Relevant typechecks and tests pass.
- [ ] Frozen golden hashes are unchanged unless an approved new version is introduced.
- [ ] README/status claims remain honest.
- [ ] API/schema changes have owner review and migration notes.
- [ ] Error paths and privacy effects were considered.

### Before hackathon submission

- [ ] Clean-machine install and startup rehearsed.
- [ ] Demo data is licensed/consented and non-sensitive.
- [ ] Live path and offline fallback both rehearsed.
- [ ] Contract deployment/explorer claims have real receipts—or are removed.
- [ ] Presentation distinguishes implemented, simulated and planned components.
- [ ] All three owners approve the final README, demo and security statements.

No Markdown linter is currently configured. Add one deliberately before treating Markdown lint as a gate.

## 15. Demo guide and judge questions

### Honest five-minute demo with the current repository

1. **Problem, 30 seconds:** explain the official “good” road record versus recent citizen “damaged” evidence.
2. **Integrity, 45 seconds:** show the frozen canonical payload, evidence root and passing golden vectors.
3. **Root and fork, 75 seconds:** create a root and fork through prepared API requests; show separate UUIDs, commit hashes and parent hash.
4. **Dashboard, 45 seconds:** refresh the React page and show both branches, evidence/reputation signals and contradiction notice.
5. **Signature and replay, 60 seconds:** run or show the authorization tests demonstrating mutation, wrong-domain and replay rejection.
6. **Challenge, 30 seconds:** submit a signed challenge and show its challenge hash and status.
7. **Honest boundary, 15 seconds:** state that persistence, wallet UI, file upload and live chain anchoring are the next integration work.

Do not demonstrate a reviewed merge, explorer proof or live anchoring as complete until those integrations exist.

### Fallback preparation

- Keep a screen recording of the complete rehearsed local flow.
- Save screenshots of dashboard states and successful test output.
- Save the canonical golden hashes and typed-data fields in slides.
- If RPC or contract deployment fails, demonstrate deterministic hashes and explicitly call anchoring planned.
- If a wallet fails, use recorded typed-data/signature output or automated ephemeral-wallet tests.
- If internet fails, use local API/web and Docker only; do not depend on remote media.
- If the API fails, show prerecorded responses and explain the exact failure rather than fabricating a live result.

### Likely judge questions

1. **Why blockchain instead of a normal database?**  
   A database is still needed for queries and private data. A shared registry adds an external, append-oriented timestamp and makes silent changes to published commitments detectable.

2. **Is this decentralized today?**  
   Not end to end. Hash/signature formats are implemented, but the API is centralized and in memory, and no contract is deployed. Decentralization is the target verification layer.

3. **Does blockchain prove the road is damaged?**  
   No. It can prove that a particular commitment was anchored; evidence and human governance determine how the claim is assessed.

4. **How do you stop fake or AI-generated photos?**  
   The MVP commits metadata and supports challenge/review. Production needs byte verification, C2PA where available, forensic risk signals, corroboration and human review. No detector is sole judge.

5. **Can officials simply claim an `official` role?**  
   Today, yes. The role is signed but not authorized. An allowlist or credential system is required before a real pilot.

6. **What prevents replay?**  
   Per-signer nonce, expiry and EIP-712 domain checks. Current nonce state is in memory; production must enforce uniqueness transactionally in PostgreSQL.

7. **How is citizen privacy protected?**  
   Large/sensitive evidence is intended to remain off-chain. Production needs consent, coordinate minimization, encryption, access controls and retention rules; those controls are not complete now.

8. **Will this scale?**  
   Only compact roots/hashes should go on-chain. Files and queries stay off-chain. Actual throughput and cost must be measured in a pilot; no scale claim has been validated.

9. **What can common citizens do without cryptocurrency?**  
   The intended relayer model can pay transaction costs while the citizen signs an authorization. That adapter is planned, so the current MVP uses API/test signing rather than a finished gasless experience.

10. **What happens when reviewers disagree or abuse power?**  
    Branches and decisions should remain inspectable, but reviewer governance, appeals and multi-party approval require institutional design before deployment.

## 16. Git workflow

The supplied project directory may not include `.git` metadata, but the team should use this workflow in the canonical repository.

1. Pull the latest agreed integration branch.
2. Create a focused branch: `backend/prisma-repository`, `frontend/reality-diff`, `web3/registry-hardening`, or `docs/readme-source-of-truth`.
3. Keep commits small and descriptive:
   - `feat(api): persist commits and parent edges transactionally`
   - `feat(web): add signed claim capture flow`
   - `test(web3): add merge authorization invariants`
   - `docs: clarify current chain integration status`
4. Rebase or merge the current integration branch only after preserving local work.
5. Open a pull request with test output, screenshots where relevant and explicit limitations.

### Pull-request checklist

- [ ] Scope is focused; unrelated formatting/refactors are excluded.
- [ ] Owner-specific and cross-layer tests pass.
- [ ] No secrets, generated files or sensitive evidence are included.
- [ ] API/schema/config changes are documented.
- [ ] Frozen-format changes use a new version and migration plan.
- [ ] UI changes include loading/error/empty states and screenshots.
- [ ] Web3 claims include real network/address/receipt evidence where applicable.

Review requirements:

- **All teammates:** `README.md`, shared public schemas, architecture decisions, governance, demo claims and environment templates.
- **Soumyanil:** `apps/api/**`, `packages/database/**`, migrations, Docker/storage config and backend-facing shared changes.
- **Mainak:** `apps/web/**`, frontend-visible API behavior, UX copy and demo screens.
- **Abhipray:** commitment/signature specifications, integrity helpers, nonce security requirements, `packages/contracts/**`, ABI/address manifests and chain-state semantics.

Never resolve overlapping edits by discarding another teammate's working tree. Compare both changes, identify the interface owner, retain tests from both sides and resolve the shared contract together. Never commit real `.env` values or paste secrets into issues, prompts, logs or screenshots.

## 17. Known limitations and honest claims

### What works now

- Deterministic RealityCommit V1 and Evidence V1 hashing with fixed golden vectors.
- Deterministic evidence Merkle roots.
- EIP-712 commit and challenge authorization verification.
- Chain/contract domain binding and expiry, with process-local API replay protection and persistent on-chain per-signer replay protection.
- In-memory root, fork, challenge, listing and history API behavior.
- A basic read-only React commit dashboard.
- A valid Prisma schema and local PostgreSQL/MinIO service definitions.
- A locally compiled and tested Solidity registry with administrator-managed relayer/reviewer roles, frozen EIP-712 verification and on-chain replay protection.

### What is simulated or local-only

- Unsigned demo writes, when explicitly enabled.
- Caller-provided evidence URIs and SHA-256 values.
- Caller-provided AI-risk scores.
- Dummy registry address used as an EIP-712 domain in local tests.
- In-memory persistence and nonce tracking.
- Source reputation starting values.

### What remains centralized

The Fastify API validates and stores all current records in one process. There is no distributed evidence store integration, deployed registry, independent indexer, durable nonce database or decentralized reviewer governance.

### What blockchain can prove

After a real deployment and adapter exist, a confirmed transaction can prove that specific hashes and parent relationships were submitted to a particular contract on a particular chain by a transaction sender at an approximate chain time.

### What blockchain cannot prove

It cannot prove that a road was actually damaged, that media was honestly captured, that a wallet represents a named citizen or official, that reviewers are unbiased, or that off-chain evidence remains available.

### What requires governance before public deployment

Official/reviewer credentialing, conflict-of-interest rules, multi-party approvals, appeals, moderation, lawful removal, privacy/consent, data retention, public-record compatibility, relayer funding/abuse controls and incident response all require institutional agreement. RealityFork should not be publicly deployed for civic decisions until those controls, durable infrastructure and independent security/privacy reviews exist.

---

For implementation details, start with [the architecture notes](docs/architecture.md), [integrity specification](docs/integrity-spec.md), [identity/signature specification](docs/identity-and-signature-spec.md), [security notes](docs/security.md) and [current demo notes](docs/demo.md). Treat this README's implementation-status table as the summary source of truth and the versioned specifications as normative for bytes and signatures.
