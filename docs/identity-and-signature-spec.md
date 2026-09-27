# RealityFork identity and signature specification

Status: implemented V2 authorization layer
Domain version: `2`
Commit commitment: frozen `realityfork.commit.v1`

This layer proves that an EVM wallet authorized a specific RealityFork request. The API verifies signatures locally and never needs, accepts or logs a claimant private key. Signed lifecycle routes then pass the verified public authorization to the configured mock or local-EVM adapter; the claimant private key never crosses that boundary.

## Identity boundaries

- **Claimant:** the person or organization making an observation. For a Web3 claimant, `authorId` is the lowercased signer wallet address.
- **Wallet signer:** the EVM account proving control of a private key by signing EIP-712 typed data. For signed commits it must be the claimant; for challenges it must be the challenger.
- **Uploader:** the client or service transferring evidence bytes. Uploading does not make that party the claimant or signer.
- **Relayer:** a backend or service that may later submit an already-authorized commitment on-chain. Its wallet is operational infrastructure and must remain distinct from the claimant wallet.
- **Reviewer:** an address granted the contract's `REVIEWER_ROLE`; its transaction directly authorizes a reviewed merge. Signing with `authorRole: "reviewer"` does not grant that authority.
- **Registry administrator:** the address or governance account holding the contract's `DEFAULT_ADMIN_ROLE`, which manages the relayer/reviewer allowlists.

`authorRole` remains a signed claim inside RealityCommit V1. Wallet recovery proves wallet control, not that the signer is a government official, trusted sensor or authorized reviewer. Those permissions require a future allowlist or credential system.

## EIP-712 domain

Both authorization types use exactly this domain:

```text
name:              RealityFork
version:           2
chainId:           SIGNATURE_CHAIN_ID
verifyingContract: REGISTRY_CONTRACT_ADDRESS
```

The API verifier uses the contract address as a domain separator but does not submit a transaction. The Solidity registry independently verifies the same domain on-chain. A signature for another chain, registry address or domain version is rejected before nonce consumption.

## Commit authorization

RealityCommit V1 is unchanged. The API first reconstructs its canonical evidence root, resolves parent UUIDs into parent commit hashes, sorts a two-parent merge according to the frozen V1 rule, and calculates the frozen canonical commit hash. It then verifies this V2 typed message:

```solidity
RealityCommitAuthorizationV2(
  bytes32 commitHash,
  bytes32 evidenceRoot,
  bytes32 parentA,
  bytes32 parentB,
  address author,
  uint256 nonce,
  uint64 expiresAt
)
```

`commitHash` and `evidenceRoot` contain the raw 32 bytes represented by the existing lowercase SHA-256 digests. Parent mapping is exact: a root signs `(0, 0)`, a fork signs `(parent, 0)`, and a merge signs its two lexicographically sorted canonical hashes. `author` must match the recovered wallet, the submitted `signerAddress`, and the lowercased `authorId`. `expiresAt` is a Unix timestamp in seconds. JSON transports `nonce` as an unsigned base-10 string to avoid number precision loss.

The API derives these parent hashes from resolved parent records; clients do not supply an independent trusted lineage value. If the signed pair differs from the canonical pair reconstructed from `parentIds`, recovery fails. On-chain root/fork and merge functions hash the exact submitted `parentA` and `parentB` into the V2 authorization, so a relayer cannot substitute lineage without invalidating the signature.

The signature is metadata around the commit. Signature, signed parents, nonce, expiry, chain ID and contract address do not enter RealityCommit V1 and therefore do not change its frozen golden hashes.

### Clean migration from authorization V1

The earlier `RealityCommitAuthorization` type and domain version `1` are retired. New API signed endpoints and new contract write functions accept only `RealityCommitAuthorizationV2` under domain version `2`. There are no deployed RealityRegistry contracts or production V1 signatures to migrate, so no compatibility path is provided. A V1 signature recovers a different address under the V2 digest and is rejected without consuming its nonce.

## Challenge commitment and authorization

The canonical challenge is:

```ts
interface CanonicalChallengeV1 {
  schemaVersion: "realityfork.challenge.v1";
  targetCommitHash: string;
  challenger: string;
  reason: "contradictory_evidence" | "wrong_location" | "wrong_time" | "synthetic_media" | "other";
  note: string;
  challengeEvidenceRoot: string;
  nonce: string;
  expiresAt: number;
}
```

It uses the canonical JSON and SHA-256 rules from `integrity-spec.md`. The challenger is normalized to lowercase. `nonce` is normalized base-10 and `expiresAt` is Unix seconds.

Non-empty challenge evidence uses the RealityFork Evidence V1 Merkle algorithm. An empty challenge evidence list has the explicitly defined root `SHA256(UTF8(canonicalize([])))`, allowing a signed textual challenge without falsely representing an empty list as a normal evidence Merkle tree.

The challenge hash remains canonical RealityChallenge V1. Its EIP-712 message fields remain unchanged, but it now uses the shared RealityFork domain version `2` for consistency with the registry:

```solidity
RealityChallengeAuthorization(
  bytes32 challengeHash,
  bytes32 targetCommitHash,
  bytes32 challengeEvidenceRoot,
  address challenger,
  uint256 nonce,
  uint64 expiresAt
)
```

The API currently stores the challenge off-chain. The Solidity registry can independently anchor the same signed challenge through an allowlisted relayer.

## Replay protection

Nonces are unique per normalized signer address across signed commit and challenge operations.

- A successful operation permanently consumes `(signerAddress, nonce)` for the process lifetime.
- The same numeric nonce may be used by another signer.
- Expired, malformed, wrong-domain and invalid-signature requests do not consume a nonce.
- In memory, nonce marking and store mutation run in one synchronous critical section. If storage throws, the nonce mark is rolled back.
- Restarting the API clears in-memory nonce history. This is an MVP limitation.

Persistent storage must use a table with a unique constraint on normalized `(signerAddress, nonce)`. In one Prisma database transaction, it must insert the nonce row and create the commit or challenge. A uniqueness failure is a replay; any operation failure must roll back both changes. The `PrismaNonceTransaction` interface in `apps/api/src/nonce.ts` records this requirement without adding a migration in this task.

## API requests

Signed routes:

- `POST /api/signed/commits`
- `POST /api/signed/commits/:id/forks`
- `POST /api/signed/commits/:id/challenges`
- `POST /api/signed/merges`

Commit and challenge bodies use this envelope:

```json
{
  "input": { "...": "the existing commit or challenge input" },
  "authorization": {
    "signerAddress": "0x...",
    "signature": "0x...",
    "nonce": "1",
    "expiresAt": 1790430000,
    "chainId": 31337,
    "registryContractAddress": "0x..."
  }
}
```

Signed envelopes are strict. Unexpected fields such as a private key are rejected. The API stores the public signature, signer, nonce, expiry, domain and verification timestamp.

The legacy unsigned routes remain available only when `ALLOW_UNSIGNED_DEMO_MODE=true` **and** `BLOCKCHAIN_ADAPTER_MODE=mock`. The default is disabled. EVM mode always rejects unsigned writes. Unsigned mode is for local demonstrations and supplies no wallet-control proof, replay protection or chain anchor.

Signed creation responses include the stored blockchain-anchor lifecycle. `GET` and `POST /api/commits/:id/blockchain-anchor` and `/api/challenges/:id/blockchain-anchor` read or retry that lifecycle. A chain failure does not roll back the off-chain record. Reviewed merges require exactly two parent IDs and supersede those parents only after confirmed anchoring and, in EVM mode, successful read-back verification.

Reviewed merge creation and merge-anchor retry additionally require `x-reviewer-token` to match a configured `REVIEWER_API_TOKEN` of at least 32 bytes. This prevents a public caller from exercising the API's reviewer wallet solely by presenting an author signature. It is a local operational safeguard, not a substitute for production reviewer authentication, governance or multi-party approval.

## Configuration

```dotenv
CHAIN_ID=31337
SIGNATURE_CHAIN_ID=31337
REGISTRY_CONTRACT_ADDRESS=<contractAddress from packages/contracts/deployments/31337.json>
REVIEWER_API_TOKEN=<32+ byte random local secret>
ALLOW_UNSIGNED_DEMO_MODE=false
```

`CHAIN_ID`, `SIGNATURE_CHAIN_ID`, the manifest chain ID and the EIP-712 domain chain ID must agree. `REGISTRY_CONTRACT_ADDRESS` must equal both the manifest contract address and the EIP-712 `verifyingContract`. No claimant private key belongs in API configuration; a future relayer key must be independently managed and must never be treated as the claimant identity.

## Security meaning and limitations

A valid V2 commit signature proves that the holder of a wallet key authorized the exact commit hash, evidence root, canonical parent pair, author, nonce and expiry for one chain and registry. A valid challenge signature binds its unchanged RealityChallenge V1 hash and fields to the same V2 domain. Mutations invalidate either signature.

It does not prove:

- that a real-world claim is true;
- that an evidence file is authentic;
- that an `official` or `reviewer` role claim is authorized;
- that claimant and wallet correspond to a verified legal identity;
- that a relayer submitted anything on-chain.

Before contract integration, nonce state must be durable, official/reviewer authorization must be defined, key-compromise and revocation policy must be established, and contract-side authorization semantics must be reconciled with this off-chain envelope.
