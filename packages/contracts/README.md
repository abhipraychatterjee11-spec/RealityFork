# RealityRegistry

`RealityRegistry.sol` is RealityFork's compact EVM integrity registry. It stores hashes, lineage, actors, timestamps and state transitions. It does not store evidence bytes and does not decide whether a real-world claim is true.

## Governance and roles

The constructor takes one non-zero `initialAdmin` and grants it OpenZeppelin's `DEFAULT_ADMIN_ROLE`. No relayer or reviewer is implicitly trusted.

- `DEFAULT_ADMIN_ROLE` may grant and revoke the operational roles. For any non-local deployment this should be a governed multisig or timelock, not an individual hot wallet.
- `RELAYER_ROLE` may submit signed roots, one-parent forks and challenges. The relayer pays gas but is recorded separately from the author or challenger.
- `REVIEWER_ROLE` may submit signed two-parent merges. The reviewer is recorded separately from the merge author.

Role membership is chain-local. The contract does not prove a wallet's civil identity, employment, expertise or impartiality.

## Versioned signatures

The contract uses OpenZeppelin EIP-712 with domain name `RealityFork`, version `2`, the current chain ID and the deployed registry address. RealityCommit V1 and RealityChallenge V1 canonical hashes remain frozen; only the authorization protocol migrated. It verifies these structures from `docs/identity-and-signature-spec.md`:

```text
RealityCommitAuthorizationV2(bytes32 commitHash,bytes32 evidenceRoot,bytes32 parentA,bytes32 parentB,address author,uint256 nonce,uint64 expiresAt)
RealityChallengeAuthorization(bytes32 challengeHash,bytes32 targetCommitHash,bytes32 challengeEvidenceRoot,address challenger,uint256 nonce,uint64 expiresAt)
```

V1 commit signatures and all domain-version-1 signatures are rejected. `usedNonces[signer][nonce]` is one shared on-chain nonce namespace for both authorization types. A nonce is consumed only after expiry and signature checks pass; a reverted transaction consumes nothing. An authorization expires when `block.timestamp >= expiresAt`. Chain ID and verifying-contract address are enforced by the EIP-712 domain.

## Write methods and transitions

| Method | Caller | Requirements | Result |
|---|---|---|---|
| `anchorSignedCommit` | Relayer | New non-zero commit/evidence hashes; zero parents or one existing, non-superseded parent; valid author authorization | Creates `Active`; records author and relayer |
| `anchorReviewedMerge` | Reviewer | New non-zero hashes; two distinct, existing, non-superseded parents in canonical ascending order; valid author authorization over that pair | Creates `Merged`; atomically sets both parents to `Superseded`; records author and reviewer |
| `anchorSignedChallenge` | Relayer | Unique non-zero challenge hash/root; existing non-superseded target; valid challenger authorization | Increments challenge count; `Active` becomes `Challenged`; `Challenged`/`Merged` retain status |

Statuses are `Active = 0`, `Challenged = 1`, `Merged = 2`, and `Superseded = 3`. Anchors are append-only; only the defined challenge and merge transitions mutate status.

Events are `CommitAnchored`, `CommitChallenged` and `CommitMerged`. Read access is available through `getCommit`, the focused author/relayer/reviewer/parents/evidence/status methods, `commitExists`, `challengeCount`, `usedNonces`, and `usedChallengeHashes`.

## Lineage binding and reviewer authority

`RealityCommitAuthorizationV2` binds `parentA` and `parentB` alongside the commit and evidence hashes. A relayer cannot change root/fork lineage without invalidating the author's signature. Merges additionally require canonical ascending parent order. The reviewer directly authorizes that exact relationship by sending the role-gated merge transaction; `CommitMerged` records the reviewer, merge hash and both parents.

The contract still cannot reconstruct the canonical RealityCommit V1 JSON preimage. The API/shared implementation must therefore derive the signed parent pair from the same canonical parent list used to calculate `commitHash`. V2 makes any later relayer substitution detectable and invalid, but it does not prove the off-chain application originally calculated the canonical hash honestly.

## Local verification

From the repository root:

```powershell
pnpm contracts:compile
pnpm contracts:test
```

Tests use ephemeral keys and a simulated Hardhat chain. No private key, public RPC or deployment is required. This repository intentionally contains no public deployment or deployed-address claim.

## Local deployment workflow

The workflow is deliberately restricted to Hardhat's in-process network and `localhost`. Any other network name is rejected by the deployment module.

In terminal one, start the persistent local node:

```powershell
pnpm contracts:node
```

Hardhat prints unlocked development accounts. In terminal two, either leave the role variables blank to select the first three local accounts (administrator/deployer, relayer, reviewer), or set them to unlocked addresses printed by the node:

```powershell
$env:CHAIN_RPC_URL = "http://127.0.0.1:8545"
$env:CONTRACT_ADMIN_ADDRESS = ""
$env:RELAYER_ADDRESS = ""
$env:REVIEWER_ADDRESS = ""
pnpm contracts:deploy:local
```

The deployment command:

1. validates that all configured role addresses are nonzero EVM addresses and that the administrator is locally unlocked;
2. refuses any non-local network and refuses to replace an existing manifest;
3. deploys `RealityRegistry` with the administrator;
4. grants `RELAYER_ROLE` and `REVIEWER_ROLE`;
5. verifies the on-chain EIP-712 domain is `RealityFork` version `2`;
6. exports the ABI and writes the deployment manifest.

It prints addresses and transaction provenance, never private keys. `PRIVATE_KEY` is not needed for the unlocked Hardhat accounts and is not read by this script.

### ABI and manifest

- [`abi/RealityRegistry.json`](abi/RealityRegistry.json) is the stable ABI for future API/frontend imports. It is generated by `pnpm contracts:export:abi` and should be committed when the contract interface changes.
- `deployments/<chainId>.json` is generated local deployment provenance. Local manifests are ignored by Git because a restarted Hardhat chain invalidates their addresses. They must not be presented as public deployments.
- The deployment writer uses create-only filesystem semantics. A second deployment for the same chain ID fails rather than silently overwriting history.

Manifest fields are:

```json
{
  "manifestSchemaVersion": "realityfork.deployment.v1",
  "contractName": "RealityRegistry",
  "chainId": 31337,
  "networkName": "localhost",
  "contractAddress": "0x...",
  "deploymentTransactionHash": "0x...",
  "deploymentBlockNumber": "1",
  "deployedAt": "2026-09-27T00:00:00.000Z",
  "administratorAddress": "0x...",
  "relayerAddress": "0x...",
  "reviewerAddress": "0x...",
  "eip712Domain": {
    "name": "RealityFork",
    "version": "2",
    "chainId": 31337,
    "verifyingContract": "0x..."
  },
  "abiPath": "packages/contracts/abi/RealityRegistry.json",
  "gitCommitHash": null
}
```

After deployment, copy `chainId` to both `CHAIN_ID` and `SIGNATURE_CHAIN_ID`, and copy `contractAddress` to `REGISTRY_CONTRACT_ADDRESS`. A signature created for another chain ID or registry address is invalid by design.

Public deployment requires a separate reviewed network configuration, funded deployer, secret manager, governed administrator, audit and explicit authorization. No public deployment command is provided.

## API lifecycle boundary

The Fastify API submits verified V2 roots/forks and challenges through a relayer and reviewed merges through a reviewer. It records transaction lifecycle metadata and retries failed/pending submissions idempotently. For local EVM confirmations it reads the anchor back and compares hash, evidence root, canonical parents, author, status, chain and registry address. A reconciliation mismatch is an API failure even when a transaction receipt succeeded.

Because the reviewer transaction itself is authoritative, API merge creation and merge retry also require the local `x-reviewer-token` header to match a configured 32-byte-or-longer `REVIEWER_API_TOKEN`. This is only a development boundary; public operation requires authenticated reviewers and governed key custody.

The API deliberately does not make database and chain writes atomic. Off-chain records survive adapter failure, while merge parents are superseded only after the merge anchor is confirmed and reconciled. Durable outbox persistence, restart recovery, reorg handling and event indexing remain required before any public deployment.
