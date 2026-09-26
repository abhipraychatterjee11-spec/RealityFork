# RealityRegistry

`RealityRegistry.sol` is RealityFork's compact EVM integrity registry. It stores hashes, lineage, actors, timestamps and state transitions. It does not store evidence bytes and does not decide whether a real-world claim is true.

## Governance and roles

The constructor takes one non-zero `initialAdmin` and grants it OpenZeppelin's `DEFAULT_ADMIN_ROLE`. No relayer or reviewer is implicitly trusted.

- `DEFAULT_ADMIN_ROLE` may grant and revoke the operational roles. For any non-local deployment this should be a governed multisig or timelock, not an individual hot wallet.
- `RELAYER_ROLE` may submit signed roots, one-parent forks and challenges. The relayer pays gas but is recorded separately from the author or challenger.
- `REVIEWER_ROLE` may submit signed two-parent merges. The reviewer is recorded separately from the merge author.

Role membership is chain-local. The contract does not prove a wallet's civil identity, employment, expertise or impartiality.

## Frozen signatures

The contract uses OpenZeppelin EIP-712 with domain name `RealityFork`, version `1`, the current chain ID and the deployed registry address. It verifies the frozen structures from `docs/identity-and-signature-spec.md` exactly:

```text
RealityCommitAuthorization(bytes32 commitHash,bytes32 evidenceRoot,address author,uint256 nonce,uint64 expiresAt)
RealityChallengeAuthorization(bytes32 challengeHash,bytes32 targetCommitHash,bytes32 challengeEvidenceRoot,address challenger,uint256 nonce,uint64 expiresAt)
```

`usedNonces[signer][nonce]` is one shared on-chain nonce namespace for both authorization types. A nonce is consumed only after expiry and signature checks pass; a reverted transaction consumes nothing. An authorization expires when `block.timestamp >= expiresAt`. Chain ID and verifying-contract address are enforced by the EIP-712 domain.

## Write methods and transitions

| Method | Caller | Requirements | Result |
|---|---|---|---|
| `anchorSignedCommit` | Relayer | New non-zero commit/evidence hashes; zero or one existing parent; valid author authorization | Creates `Active`; records author and relayer |
| `anchorReviewedMerge` | Reviewer | New non-zero hashes; two distinct, existing, non-superseded parents; valid author authorization | Creates `Merged`; atomically sets both parents to `Superseded`; records author and reviewer |
| `anchorSignedChallenge` | Relayer | Unique non-zero challenge hash/root; existing non-superseded target; valid challenger authorization | Increments challenge count; `Active` becomes `Challenged`; `Challenged`/`Merged` retain status |

Statuses are `Active = 0`, `Challenged = 1`, `Merged = 2`, and `Superseded = 3`. Anchors are append-only; only the defined challenge and merge transitions mutate status.

Events are `CommitAnchored`, `CommitChallenged` and `CommitMerged`. Read access is available through `getCommit`, the focused author/relayer/reviewer/parents/evidence/status methods, `commitExists`, `challengeCount`, `usedNonces`, and `usedChallengeHashes`.

## Important trust boundary

The frozen commit signature binds `commitHash` and `evidenceRoot`, while canonical parent hashes are inside the off-chain SHA-256 commit preimage. Solidity cannot reconstruct that canonical JSON preimage from the compact arguments. Consequently, the contract validates parent existence and transition rules but cannot prove that the separately supplied `parentA`/`parentB` arguments are the parents committed inside `commitHash`. The authorized relayer/reviewer and a future indexer must verify this correspondence using the frozen shared implementation before submission. Changing the frozen signature shape would require a separately versioned protocol migration.

## Local verification

From the repository root:

```powershell
pnpm contracts:compile
pnpm contracts:test
```

Tests use ephemeral keys and a simulated Hardhat chain. No private key, public RPC or deployment is required. This repository intentionally contains no public deployment or deployed-address claim.
