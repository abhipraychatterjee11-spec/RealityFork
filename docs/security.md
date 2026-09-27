# RealityFork security review and threat model

Review date: 2026-09-27

Scope: Solidity registry and tests, RealityCommit V1/Evidence V1 hashing, EIP-712 Authorization V2, API authorization and nonces, mock/local-EVM adapters, lifecycle and retry routes, local deployment and manifest handling, environment configuration, and security claims. No public deployment or external infrastructure was assessed.

## Security meaning

Blockchain anchoring can prove that particular hashes, lineage values, actors and state transitions were recorded by a particular contract on a particular chain. It does **not** prove that a civic claim is true, that evidence is authentic, that a wallet belongs to a named person, or that an `official`/`reviewer` claim is legitimate.

## Threat model and trust boundaries

- Clients, evidence metadata, URIs, coordinates, claimed roles and AI-risk scores are untrusted.
- Claimant/challenger wallets are trusted only to authorize exact EIP-712 fields. Their legal identity and institutional role are not established.
- The API is trusted to reconstruct canonical hashes, enforce its process-local nonce set, retain records, and choose the configured adapter. It currently has no durable database boundary.
- The relayer may pay gas but cannot change a signed commit hash, evidence root, parent pair, author, nonce or expiry. A compromised relayer can censor, reorder, or spend funds on valid authorizations.
- The reviewer transaction sender is an authority: it approves an exact two-parent merge. The API's reviewer token is a local compensating control, not production reviewer identity or governance.
- `DEFAULT_ADMIN_ROLE` can grant/revoke operational roles. Compromise of the single administrator compromises contract governance.
- The local deployment manifest, ABI, environment and loopback Hardhat RPC are trusted operational inputs. They are not cryptographically authenticated.
- Mock mode is a simulation. Every response must remain labeled `mock: true`; it is never blockchain proof.
- Object storage, Prisma persistence, frontend wallet behavior, proxies, TLS, host hardening and public RPCs are outside the implemented boundary.

## Current controls

- Frozen RealityCommit V1 and Evidence V1 canonical JSON/SHA-256 rules, strict lowercase digests, timestamp normalization, duplicate-evidence rejection and deterministic Merkle construction.
- Authorization V2 signs commit hash, evidence root, both canonical parent hashes, author, nonce and expiry under `RealityFork` domain version `2`, chain ID and registry address.
- Challenge authorization binds challenge hash, target hash, challenge evidence root, challenger, nonce and expiry.
- API independently rebuilds hashes and parent hashes from stored records before signer recovery.
- Per-signer nonces share one namespace across commit/challenge types in both API and contract; Solidity state persists nonce use and reverts atomically.
- OpenZeppelin ECDSA/EIP712/AccessControl enforce signature validity, domain separation and role gates.
- Contract rejects zero hashes, duplicates, expired authorizations, missing/superseded parents and targets, noncanonical merge order, and unauthorized callers.
- Local EVM startup checks loopback RPC, manifest/environment chain and address agreement, EIP-712 domain, unlocked role accounts, and on-chain role membership before each write.
- API distinguishes pending/confirmed/failed state, verifies confirmed EVM commit anchors, and does not supersede merge parents before confirmation/reconciliation.
- Mock-only unsigned writes require both explicit demo mode and a mock adapter.
- Reviewed merge creation and retry require a minimum-32-byte `REVIEWER_API_TOKEN` supplied as `x-reviewer-token`; comparison is constant-time for equal-length values.
- Deployment is restricted to named local Hardhat networks/loopback RPC and manifests use create-only writes.
- Private keys are neither accepted in signed request schemas nor read/logged by the current unlocked-account local workflow.

## Findings

### Critical

No Critical findings were identified in the reviewed local implementation.

### High — fixed: reviewer authority was exposed through unauthenticated API routes

- **References:** `apps/api/src/app.ts:116-137`, `apps/api/src/app.ts:216-225`, `apps/api/src/app.ts:358-376`; regression coverage in `apps/api/test/blockchain-lifecycle.test.ts`.
- **Attack scenario:** any caller holding a valid author-signed two-parent authorization could cause the backend's unlocked `REVIEWER_ROLE` account to send the approving transaction. A caller could also trigger a merge retry. The contract would see an authorized reviewer even though no reviewer approved the HTTP request.
- **Why it matters:** this collapsed author consent and reviewer governance into one public request and let untrusted callers exercise a privileged server wallet.
- **Recommended fix:** require separate reviewer-side authorization for merge creation and retry.
- **Safe to fix now:** yes; fixed with a fail-closed, minimum-32-byte API token and timing-safe comparison. This is a local control only; production still needs authenticated reviewer identities, policy, audit logging, rotation and preferably multi-party governance.

### Medium: nonce and idempotency state are process-local

- **References:** `apps/api/src/nonce.ts:30-49`, `apps/api/src/blockchain/evm.ts:41`, `apps/api/src/blockchain/evm.ts:150-159`, `apps/api/src/blockchain/mock.ts:39`, `apps/api/src/blockchain/mock.ts:107-130`.
- **Attack scenario:** restart the API or send the same signed request to two instances. Each process can create its own off-chain record and submission state. The contract prevents a second successful nonce use, but off-chain duplicates and inconsistent lifecycle records remain possible.
- **Why it matters:** replay protection and retry coordination are not durable or multi-instance safe.
- **Recommended fix:** transactionally persist normalized `(signer, nonce)`, outbox item and idempotency key with unique constraints; reconcile receipts into one durable record.
- **Safe to fix now:** no; it requires the excluded Prisma/outbox integration.

### Medium: public relayer endpoints permit spending and availability abuse

- **References:** signed writes at `apps/api/src/app.ts:286-376`; retry routes at `apps/api/src/app.ts:216-242`.
- **Attack scenario:** an attacker submits many valid authorizations or repeatedly exercises pending/failed relayer retries, consuming server/RPC capacity and potentially relayer gas. Signatures protect content integrity, not sponsorship policy.
- **Why it matters:** a public gasless service needs quotas, identity/risk controls and spending limits.
- **Recommended fix:** authenticated/rate-limited policy, per-signer quotas, funding alarms and a durable queue.
- **Safe to fix now:** no; production abuse policy is not defined.

### Medium: mock confirmation does not enforce every Solidity invariant

- **References:** `apps/api/src/blockchain/mock.ts:57-76`, `apps/api/src/blockchain/mock.ts:133-158`; Solidity checks at `packages/contracts/contracts/RealityRegistry.sol:97-176` and `packages/contracts/contracts/RealityRegistry.sol:228-302`.
- **Attack scenario:** direct mock calls, or API flows involving superseded/unanchored parents, may produce `confirmed` mock metadata even though Solidity would reject the transition. Mock merges also do not update mock parent anchors to `superseded`.
- **Why it matters:** a local demonstration can imply contract-equivalent behavior when the simulator is lighter-weight.
- **Recommended fix:** make the mock enforce the same parent/target/duplicate/status/nonce rules, or explicitly restrict it to transport testing. Always show `mock: true`.
- **Safe to fix now:** no; exact simulator semantics need a deliberate adapter contract and broader tests.

### Medium: API accepts superseded-parent/target records before adapter rejection

- **References:** `apps/api/src/store.ts:32-53`, `apps/api/src/store.ts:80-100`; contract rejection at `packages/contracts/contracts/RealityRegistry.sol:173-176` and `packages/contracts/contracts/RealityRegistry.sol:234-242`.
- **Attack scenario:** a client creates a fork, merge or challenge against an off-chain record already marked superseded. The API retains it, then real EVM anchoring fails. Challenge creation also marks the target challenged before chain outcome.
- **Why it matters:** off-chain workflow state can diverge from registry-valid state and confuse clients that ignore anchor metadata.
- **Recommended fix:** define proposal versus accepted-chain states, reject obviously ineligible targets before nonce consumption, and document when challenge state becomes effective.
- **Safe to fix now:** no; off-chain proposal semantics need backend/product agreement.

### Medium: timed-out transactions are not actively reconciled by retry routes

- **References:** polling at `apps/api/src/blockchain/evm.ts:106-117`, timeout state at `apps/api/src/blockchain/evm.ts:178-188`, retry at `apps/api/src/app.ts:216-225`.
- **Attack scenario:** a transaction times out locally and later confirms. The cached operation stays `pending`; retry returns that cached state instead of polling, so API state can remain pending and merge parents may never transition.
- **Why it matters:** users can receive stale confirmation state even though the registry changed.
- **Recommended fix:** poll known transaction hashes on status/retry, then add durable receipt/event reconciliation and reorg handling.
- **Safe to fix now:** no; partial polling is possible, but durable reconciliation is the correct fix.

### Medium: one confirmation and no reorg/event reconciliation

- **References:** `apps/api/src/blockchain/config.ts:107-108`, `apps/api/src/blockchain/evm.ts:178-188`.
- **Attack scenario:** on a non-local chain, a shallow confirmation is reorganized out while the API retains `confirmed` and merge-parent state.
- **Why it matters:** receipt success is not permanent finality.
- **Recommended fix:** network-specific finality, canonical block hashes, event indexing and reorg rollback.
- **Safe to fix now:** no; public networks are unsupported.

### Medium: manifest and ABI authenticity are not cryptographically established

- **References:** `apps/api/src/blockchain/config.ts:39-109`, `packages/contracts/scripts/deployment.ts:131-161`.
- **Attack scenario:** a local attacker alters both manifest/configured address or replaces the ABI/compatible contract. Startup checks consistency and EIP-712 domain but not runtime bytecode hash or signed provenance.
- **Why it matters:** configuration consistency is not deployment authenticity.
- **Recommended fix:** version a runtime bytecode hash and build provenance into the manifest, verify `eth_getCode`, sign/review manifests and restrict file permissions.
- **Safe to fix now:** no; this requires a manifest schema migration.

### Medium: centralized `DEFAULT_ADMIN_ROLE` can escalate all privileges

- **References:** `packages/contracts/contracts/RealityRegistry.sol:84`; inherited OpenZeppelin role management.
- **Attack scenario:** compromise of the administrator grants attacker relayer/reviewer roles or revokes legitimate operators.
- **Why it matters:** all allowlists depend on one key, and a reviewer can supersede branches.
- **Recommended fix:** production multisig/timelock, separate keys, monitored role events and tested rotation. Consider `AccessControlDefaultAdminRules` in a future reviewed contract version.
- **Safe to fix now:** no; governance policy must be selected first.

### Medium: public responses expose identifying metadata

- **References:** permissive CORS at `apps/api/src/app.ts:199`; coordinates at `packages/shared/src/index.ts:9-10`; list/history responses include wallet `authorId`, evidence URI and timestamps.
- **Attack scenario:** any browser origin can enumerate wallet-linked claims, evidence URIs, precise coordinates and times from a reachable API.
- **Why it matters:** civic-reporting metadata can identify residents, movements or sensitive locations even when media stays off-chain.
- **Recommended fix:** data classification, minimization, consent, redacted public DTOs, access control, restrictive CORS, encryption and retention policy.
- **Safe to fix now:** no; public/private data policy and frontend contracts are undefined.

### Low: generic API errors can disclose internal details

- **References:** `apps/api/src/app.ts:43-52`.
- **Attack scenario:** a store/adapter error returns a raw message containing internal IDs, paths or operational detail.
- **Why it matters:** it can assist reconnaissance; current adapter errors are mostly sanitized, limiting impact.
- **Recommended fix:** structured server logs with correlation IDs and stable public error messages.
- **Safe to fix now:** yes, but not changed because fixes are restricted to Critical/High issues.

### Low: deployment receipt success is assumed rather than asserted

- **References:** `packages/contracts/scripts/deployment.ts:118-129`.
- **Attack scenario:** a provider returns a reverted deployment or grant receipt without the helper throwing, yet the script proceeds.
- **Why it matters:** provenance could claim roles that were not assigned; later adapter checks reduce impact.
- **Recommended fix:** assert success for deployment and grants and re-read all roles before manifest write.
- **Safe to fix now:** yes, but not changed because it is Low and local-only.

### Low: caller-provided AI risk and claimed role influence scores

- **References:** `packages/shared/src/index.ts:12`, `packages/shared/src/index.ts:26`, `apps/api/src/scoring.ts:7-18`.
- **Attack scenario:** a caller supplies a favorable AI-risk score or claims `official`/`sensor` to improve displayed scores.
- **Why it matters:** users may mistake unauthenticated triage values for verification.
- **Recommended fix:** visibly label them unverified, calculate forensic signals server-side, and authorize institutional roles through credentials/allowlists.
- **Safe to fix now:** no; scoring provenance and identity systems are absent.

### Informational: local secret and key handling is incomplete by design

- **References:** blank `PRIVATE_KEY`/`REVIEWER_API_TOKEN` in `.env.example`; unlocked local accounts at `apps/api/src/blockchain/evm.ts:211-226`.
- **Attack scenario:** copying development practices to a public host exposes privileged accounts; committing `.env` or logging tokens leaks secrets.
- **Why it matters:** unlocked accounts and a static token are local controls, not production custody.
- **Recommended fix:** secret manager/HSM or managed signer, TLS, rotation, scoped service identity and audit logs. Remove unused `PRIVATE_KEY` until a reviewed signer design uses it.
- **Safe to fix now:** documentation only; public custody is outside scope.

### Informational: Unicode strings are byte-distinct, not visually normalized

- **References:** `packages/shared/src/integrity.ts:60-101`.
- **Attack scenario:** visually similar Unicode text produces different commitments.
- **Why it matters:** this is not a hash collision, but reviewers may confuse look-alike claims.
- **Recommended fix:** keep V1 frozen; add UI confusable warnings or normalization only in a future versioned format.
- **Safe to fix now:** no; changing it would break frozen hashes.

## Production recommendations before public testnet

1. Persist nonce, records, outbox/idempotency and receipt state transactionally with unique constraints.
2. Add receipt/event reconciliation, block hashes, network-specific finality and reorg recovery.
3. Define relayer admission, rate limits, quotas, funding limits and incident response.
4. Replace the local reviewer token with authenticated reviewer identity, authorization, audit and governed custody.
5. Move admin/reviewer/relayer keys to multisig/HSM/secret-manager arrangements; test rotation and revocation.
6. Authenticate deployment manifests and verify runtime bytecode and roles before use.
7. Make mock semantics contract-equivalent or restrict it to transport testing.
8. Define privacy/consent/redaction/retention policy before exposing wallet, URI or location metadata.
9. Hash uploaded evidence bytes server-side and treat C2PA/AI outputs as review signals only.
10. Obtain independent Solidity, API, infrastructure and privacy review and rehearse recovery in an ephemeral environment.

## Local demonstration assessment

The system is suitable for a controlled local hackathon demonstration if mock responses are visibly labeled, reviewer-token and unsigned-demo settings remain local, only synthetic/non-sensitive evidence is used, and presenters do not claim public deployment, durable replay protection, production finality, institutional identity, evidence authenticity or real-world truth. It is not ready for public testnet or civic production use.
