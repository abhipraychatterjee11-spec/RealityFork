# RealityFork deterministic local demo runbook

This runbook demonstrates a synthetic dispute about **Road A17** using only generated metadata and temporary in-memory claimant wallets. It has a no-chain mock fallback and a loopback-only Hardhat EVM path. Neither path is production-ready, and neither proves that a real road observation is true.

## Presenter preparation checklist

- Use a clean local checkout with dependencies installed and all tests passing.
- Use only the built-in `synthetic://realityfork-demo/...` evidence references. Do not substitute photos, real locations, citizen names, government records or persistent wallet addresses.
- Never paste or print `REVIEWER_API_TOKEN`, private keys, mnemonics or `.env` contents.
- Confirm `CHAIN_RPC_URL` is exactly a loopback URL for the EVM scenario.
- Confirm the generated manifest address matches `REGISTRY_CONTRACT_ADDRESS` and EIP-712 `verifyingContract`.
- Rehearse Scenario A first; it is the deterministic fallback if any chain component fails.
- Run `pnpm --filter @realityfork/api test` and `pnpm contracts:test` before presentation.
- Capture screenshots only after checking that they contain no terminal secrets or personal data.

## Safe synthetic data

The runner creates this fixed narrative:

1. A temporary wallet makes a self-described `official` root claim that synthetic Road A17 is `serviceable`.
2. A second temporary wallet forks it with a `damaged` observation.
3. The API displays contradiction flags and deterministic synthetic evidence roots.
4. A third temporary wallet challenges the baseline with a synthetic document reference.
5. A fourth temporary wallet signs a two-parent `review-required` merge; a separate reviewer API token authorizes use of the backend reviewer wallet.

The wallets are generated in memory for each run, are never printed, and are discarded at process exit. Because `authorId` is part of RealityCommit V1, commit hashes legitimately differ between runs; the scenario, inputs, validation and order are repeatable.

## Scenario A: mock fallback

Required configuration is only a process-local reviewer secret. Generate it without printing it:

```powershell
$demoTokenBytes = New-Object byte[] 32
[Security.Cryptography.RandomNumberGenerator]::Fill($demoTokenBytes)
$env:REVIEWER_API_TOKEN = [Convert]::ToHexString($demoTokenBytes)
pnpm demo:mock
```

Expected banner:

```text
MODE: MOCK FALLBACK — all transaction hashes are SIMULATED; no blockchain is contacted.
```

Every anchor line must show `mock=true`. The command creates root, fork, challenge and reviewed merge through the actual Fastify lifecycle routes, then verifies the simulated merge and prints three preserved history commits. Mock transaction hashes are deterministic functions of each generated commit/challenge hash, but they are not receipts or explorer proofs.

## Scenario B: local Hardhat EVM

Use three terminals. No public RPC is accepted by the deployment or adapter configuration.

### Terminal 1 — local node

```powershell
$env:CHAIN_RPC_URL = "http://127.0.0.1:8545"
pnpm contracts:node
```

Hardhat prints development accounts. They are intentionally unsafe for any public network.

### Terminal 2 — local deployment

Ensure `packages/contracts/deployments/31337.json` does not already represent another running local chain. The deployment command deliberately refuses to overwrite it; archive/remove a stale local manifest only after confirming its old chain is no longer in use.

```powershell
$env:CHAIN_RPC_URL = "http://127.0.0.1:8545"
pnpm contracts:deploy:local
```

The script deploys `RealityRegistry`, assigns the local administrator/relayer/reviewer roles, exports the ABI, and writes the chain-ID manifest. It never reads or prints a private key.

### Terminal 3 — validated EVM demo

```powershell
$demoManifest = Get-Content packages/contracts/deployments/31337.json | ConvertFrom-Json
$env:CHAIN_RPC_URL = "http://127.0.0.1:8545"
$env:CHAIN_ID = [string]$demoManifest.chainId
$env:SIGNATURE_CHAIN_ID = [string]$demoManifest.chainId
$env:REGISTRY_CONTRACT_ADDRESS = [string]$demoManifest.contractAddress
$env:CONTRACT_MANIFEST_PATH = "packages/contracts/deployments/31337.json"
$env:CHAIN_CONFIRMATIONS = "1"
$env:CHAIN_RECEIPT_TIMEOUT_MS = "30000"
$demoTokenBytes = New-Object byte[] 32
[Security.Cryptography.RandomNumberGenerator]::Fill($demoTokenBytes)
$env:REVIEWER_API_TOKEN = [Convert]::ToHexString($demoTokenBytes)
pnpm demo:evm
```

The EVM runner validates manifest schema, chain ID, contract/domain address, ABI path, loopback RPC, unlocked relayer/reviewer accounts and on-chain EIP-712 domain before creating any record. It then prints each transaction receipt block/status and decoded `CommitAnchored`, `CommitChallenged` or `CommitMerged` events. It never prints the reviewer token or generated claimant keys.

Expected state sequence:

```text
root: active -> challenged -> superseded
fork: challenged -> superseded
merge: created only after author signature + reviewer token -> merged
final verification: verified, mock=false
history: root + fork + merge retained
```

The parent status line printed immediately before merge must say neither parent is superseded. Only a confirmed and reconciled merge changes both parents to `superseded`.

## Five-minute presentation script

### 0:00–0:40 — problem and UI context — Mainak

Explain that RealityFork preserves competing public-record observations instead of overwriting one side. Show the dashboard/history layout if available, while stating that wallet capture and detailed Reality Diff UI are incomplete.

### 0:40–1:35 — backend and evidence lifecycle — Soumyanil

Run or display the official root and citizen fork output. Point to commit IDs, evidence roots, parent hash and contradiction flags. Explain that the demo uses metadata-only synthetic evidence and in-memory persistence; AI risk is a triage input, not proof.

### 1:35–2:30 — signatures and lineage — Abhipray

Explain that temporary claimant wallets sign EIP-712 Authorization V2. Highlight chain ID, registry address, nonce, expiry, commit/evidence hashes and explicit parent binding. State that V1 canonical hashes were not changed.

### 2:30–3:15 — challenge and preserved disagreement — Soumyanil

Show the signed challenge hash and anchor state. Explain that the challenge adds history and does not erase the official or citizen observation.

### 3:15–4:15 — reviewed merge and chain proof — Abhipray

Show that both parents are not superseded before submission. Create the reviewed merge with the still-secret reviewer token. In EVM mode, point to transaction hashes, block numbers and decoded contract events; in fallback mode, explicitly say the hashes are simulated. Show parents becoming superseded only after confirmation.

### 4:15–4:45 — Reality history — Mainak

Show the root, fork and merge in history and explain the intended Reality Diff/visual graph. Do not imply that superseded means deleted or proven false.

### 4:45–5:00 — honest boundary — Abhipray

End with: **“Anchoring proves this record history, not that any real-world observation is true.”** State that persistence, file-byte verification, privacy policy, production custody, finality/reorg handling, institutional reviewer identity and public deployment remain incomplete.

## Failure fallbacks

| Failure | Safe response |
|---|---|
| API runner fails | Show the last passing automated demo test output and pre-captured sanitized mock output. Do not fabricate a response. |
| Hardhat node fails | Switch to `pnpm demo:mock` and point out `SIMULATED`/`mock=true` before continuing. |
| Deployment fails | Do not invent an address. Show contract/deployment tests, then use mock mode. |
| Wallet/signature fails | Rerun the command so new temporary wallets are generated. If it repeats, show authorization tests and use prepared sanitized output. Never paste a key. |
| Reviewer token missing | The demo must fail with `REVIEWER_AUTH_CONFIGURATION_MISSING`. Generate a new process-local 32-byte token; never bypass the guard or put it in source control. |
| Confirmation times out | Describe the result as `pending`, not confirmed. Do not rerun a public transaction blindly; for this local demo, preserve output and switch to mock fallback if necessary. |
| Manifest is invalid | Stop EVM mode. Redeploy to a fresh local chain or correct environment/manifest mismatch; never edit addresses to force startup. |
| RPC is unavailable or remote | Stop EVM mode. The adapter intentionally rejects remote hosts; use the mock fallback. |

## Screenshots and outputs to prepare

- Passing API demo tests and contract tests.
- Mock banner containing both `SIMULATED` and `mock=true`.
- Root and fork commit/evidence/parent hashes with contradiction flags.
- Challenge hash and transaction state.
- Parent statuses before and after reviewed merge.
- EVM receipt blocks and decoded event names from a rehearsed local run.
- Final `verified` anchor result and three-entry history.
- The explicit history-not-truth statement.

Crop or redact terminal chrome that contains unrelated environment information. Never capture `.env`, tokens, private keys, mnemonics or real user data.

## Honest claims

- RealityCommit V1 and Evidence V1 hashes are deterministic for identical committed inputs.
- Authorization V2 binds hashes, parents, signer, nonce, expiry, chain and contract.
- The local contract enforces relayer/reviewer roles, replay protection and lineage transitions.
- EVM-mode confirmation proves that specific commitments were recorded by this local contract.
- History preserves disagreement and superseded parents remain inspectable.

## Forbidden overclaims

- Do not say blockchain proves Road A17—or any observation—is true.
- Do not say an `official` role proves government employment or authority.
- Do not say AI risk proves media is fake or genuine.
- Do not present `mock=true` hashes as blockchain receipts.
- Do not claim durable replay protection, database persistence, production finality, privacy compliance, public deployment or security audit certification.
- Do not describe the static local reviewer token or unlocked Hardhat accounts as production key management.
