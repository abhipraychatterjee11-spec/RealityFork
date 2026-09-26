# RealityFork identity and signature specification

Status: MVP off-chain authorization layer  
Domain version: `1`  
Commit commitment: frozen `realityfork.commit.v1`

This layer proves that an EVM wallet authorized a specific RealityFork request. The API verifies signatures locally and never needs, accepts or logs a claimant private key. It does not submit transactions or modify the registry contract.

## Identity boundaries

- **Claimant:** the person or organization making an observation. For a Web3 claimant, `authorId` is the lowercased signer wallet address.
- **Wallet signer:** the EVM account proving control of a private key by signing EIP-712 typed data. For signed commits it must be the claimant; for challenges it must be the challenger.
- **Uploader:** the client or service transferring evidence bytes. Uploading does not make that party the claimant or signer.
- **Relayer:** a backend or service that may later submit an already-authorized commitment on-chain. Its wallet is operational infrastructure and must remain distinct from the claimant wallet.
- **Reviewer:** a party that may eventually approve merges. Signing with `authorRole: "reviewer"` does not grant reviewer authority.
- **Registry administrator:** a future governance or contract-administration role. It is not implemented by this MVP layer.

`authorRole` remains a signed claim inside RealityCommit V1. Wallet recovery proves wallet control, not that the signer is a government official, trusted sensor or authorized reviewer. Those permissions require a future allowlist or credential system.

## EIP-712 domain

Both authorization types use exactly this domain:

```text
name:              RealityFork
version:           1
chainId:           SIGNATURE_CHAIN_ID
verifyingContract: REGISTRY_CONTRACT_ADDRESS
```

The contract address is a domain separator for this off-chain proof; the contract is not called in this task. A signature for another chain or registry address is rejected before nonce consumption.

## Commit authorization

RealityCommit V1 is unchanged. The API first reconstructs its canonical evidence root, resolves parent UUIDs into parent commit hashes, and calculates the frozen canonical commit hash. It then verifies this typed message:

```solidity
RealityCommitAuthorization(
  bytes32 commitHash,
  bytes32 evidenceRoot,
  address author,
  uint256 nonce,
  uint64 expiresAt
)
```

`commitHash` and `evidenceRoot` contain the raw 32 bytes represented by the existing lowercase SHA-256 digests. `author` must match the recovered wallet, the submitted `signerAddress`, and the lowercased `authorId`. `expiresAt` is a Unix timestamp in seconds. JSON transports `nonce` as an unsigned base-10 string to avoid number precision loss.

The signature is metadata around the commit. Signature, nonce, expiry, chain ID and contract address do not enter RealityCommit V1 and therefore do not change its frozen golden hashes.

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

The EIP-712 message is:

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

The challenge is stored off-chain only. No challenge transaction is submitted.

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

The legacy unsigned routes remain available only when `ALLOW_UNSIGNED_DEMO_MODE=true`. The default is disabled. Unsigned mode is for local demonstrations and supplies no wallet-control proof or replay protection.

## Configuration

```dotenv
SIGNATURE_CHAIN_ID=31337
REGISTRY_CONTRACT_ADDRESS=0x1000000000000000000000000000000000000001
ALLOW_UNSIGNED_DEMO_MODE=false
```

The fixed registry address above is suitable only as a documented local/test dummy. Real environments must use the configured deployed registry address. No claimant private key belongs in API configuration; a future relayer key must be independently managed and must never be treated as the claimant identity.

## Security meaning and limitations

A valid signature proves that the holder of a wallet key authorized the exact typed message for one chain, registry domain, nonce and expiry. Because the message binds the canonical commit or challenge hashes, mutations invalidate the signature.

It does not prove:

- that a real-world claim is true;
- that an evidence file is authentic;
- that an `official` or `reviewer` role claim is authorized;
- that claimant and wallet correspond to a verified legal identity;
- that a relayer submitted anything on-chain.

Before contract integration, nonce state must be durable, official/reviewer authorization must be defined, key-compromise and revocation policy must be established, and contract-side authorization semantics must be reconciled with this off-chain envelope.
