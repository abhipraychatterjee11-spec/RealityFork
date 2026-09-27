import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";
import { getAddress, parseEventLogs, sha256, stringToHex, zeroAddress, zeroHash, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  buildChallengeAuthorizationTypedData,
  buildCommitAuthorizationTypedData
} from "@realityfork/shared";

const { viem } = await network.create();

const digest = (label: string): Hex => sha256(stringToHex(label));
const bare = (value: Hex): string => value.slice(2);

async function fixture() {
  const publicClient = await viem.getPublicClient();
  const [admin, relayer, reviewer, outsider] = await viem.getWalletClients();
  const registry = await viem.deployContract("RealityRegistry", [admin.account.address]);
  const relayerRole = await registry.read.RELAYER_ROLE();
  const reviewerRole = await registry.read.REVIEWER_ROLE();
  await registry.write.grantRole([relayerRole, relayer.account.address], { account: admin.account });
  await registry.write.grantRole([reviewerRole, reviewer.account.address], { account: admin.account });
  const chainId = await publicClient.getChainId();

  return { publicClient, admin, relayer, reviewer, outsider, registry, relayerRole, reviewerRole, chainId };
}

async function signCommit(
  chainId: number,
  contract: Address,
  account: ReturnType<typeof privateKeyToAccount>,
  commitHash: Hex,
  evidenceRoot: Hex,
  nonce: bigint,
  expiresAt: bigint,
  parentA: Hex = zeroHash,
  parentB: Hex = zeroHash
) {
  return account.signTypedData(buildCommitAuthorizationTypedData(
    { chainId, verifyingContract: contract },
    {
      commitHash: bare(commitHash),
      evidenceRoot: bare(evidenceRoot),
      parentA: bare(parentA),
      parentB: bare(parentB),
      author: account.address,
      nonce,
      expiresAt
    }
  ));
}

async function signChallenge(
  chainId: number,
  contract: Address,
  account: ReturnType<typeof privateKeyToAccount>,
  challengeHash: Hex,
  targetCommitHash: Hex,
  challengeEvidenceRoot: Hex,
  nonce: bigint,
  expiresAt: bigint
) {
  return account.signTypedData(buildChallengeAuthorizationTypedData(
    { chainId, verifyingContract: contract },
    {
      challengeHash: bare(challengeHash),
      targetCommitHash: bare(targetCommitHash),
      challengeEvidenceRoot: bare(challengeEvidenceRoot),
      challenger: account.address,
      nonce,
      expiresAt
    }
  ));
}

async function signV1Commit(
  chainId: number,
  contract: Address,
  account: ReturnType<typeof privateKeyToAccount>,
  commitHash: Hex,
  evidenceRoot: Hex,
  nonce: bigint,
  expiresAt: bigint
) {
  return account.signTypedData({
    domain: { name: "RealityFork", version: "2", chainId, verifyingContract: contract },
    primaryType: "RealityCommitAuthorization",
    types: {
      RealityCommitAuthorization: [
        { name: "commitHash", type: "bytes32" },
        { name: "evidenceRoot", type: "bytes32" },
        { name: "author", type: "address" },
        { name: "nonce", type: "uint256" },
        { name: "expiresAt", type: "uint64" }
      ]
    },
    message: { commitHash, evidenceRoot, author: account.address, nonce, expiresAt }
  });
}

async function signV2CommitWithDomainV1(
  chainId: number,
  contract: Address,
  account: ReturnType<typeof privateKeyToAccount>,
  commitHash: Hex,
  evidenceRoot: Hex,
  nonce: bigint,
  expiresAt: bigint
) {
  return account.signTypedData({
    domain: { name: "RealityFork", version: "1", chainId, verifyingContract: contract },
    primaryType: "RealityCommitAuthorizationV2",
    types: {
      RealityCommitAuthorizationV2: [
        { name: "commitHash", type: "bytes32" },
        { name: "evidenceRoot", type: "bytes32" },
        { name: "parentA", type: "bytes32" },
        { name: "parentB", type: "bytes32" },
        { name: "author", type: "address" },
        { name: "nonce", type: "uint256" },
        { name: "expiresAt", type: "uint64" }
      ]
    },
    message: {
      commitHash, evidenceRoot, parentA: zeroHash, parentB: zeroHash,
      author: account.address, nonce, expiresAt
    }
  });
}

async function future(publicClient: Awaited<ReturnType<typeof viem.getPublicClient>>) {
  const block = await publicClient.getBlock();
  return block.timestamp + 3600n;
}

async function anchorRoot(ctx: Awaited<ReturnType<typeof fixture>>, label: string, nonce = 0n) {
  const author = privateKeyToAccount(generatePrivateKey());
  const commitHash = digest(`${label}:commit`);
  const evidenceRoot = digest(`${label}:evidence`);
  const expiresAt = await future(ctx.publicClient);
  const signature = await signCommit(ctx.chainId, ctx.registry.address, author, commitHash, evidenceRoot, nonce, expiresAt);
  const tx = await ctx.registry.write.anchorSignedCommit(
    [commitHash, evidenceRoot, zeroHash, zeroHash, author.address, nonce, expiresAt, signature],
    { account: ctx.relayer.account }
  );
  await ctx.publicClient.waitForTransactionReceipt({ hash: tx });
  return { author, commitHash, evidenceRoot, expiresAt, signature, tx };
}

describe("RealityRegistry", () => {
  it("assigns admin explicitly and lets admin manage relayer/reviewer roles", async () => {
    const ctx = await fixture();
    assert.equal(await ctx.registry.read.hasRole([await ctx.registry.read.DEFAULT_ADMIN_ROLE(), ctx.admin.account.address]), true);
    await ctx.registry.write.grantRole([ctx.relayerRole, ctx.outsider.account.address], { account: ctx.admin.account });
    assert.equal(await ctx.registry.read.hasRole([ctx.relayerRole, ctx.outsider.account.address]), true);
    await ctx.registry.write.revokeRole([ctx.relayerRole, ctx.outsider.account.address], { account: ctx.admin.account });
    assert.equal(await ctx.registry.read.hasRole([ctx.relayerRole, ctx.outsider.account.address]), false);
  });

  it("rejects unauthorized callers and unsigned/incorrect authorizations", async () => {
    const ctx = await fixture();
    const author = privateKeyToAccount(generatePrivateKey());
    const wrong = privateKeyToAccount(generatePrivateKey());
    const commitHash = digest("auth:commit");
    const evidenceRoot = digest("auth:evidence");
    const expiresAt = await future(ctx.publicClient);
    const signature = await signCommit(ctx.chainId, ctx.registry.address, wrong, commitHash, evidenceRoot, 1n, expiresAt);
    await assert.rejects(ctx.registry.write.anchorSignedCommit(
      [commitHash, evidenceRoot, zeroHash, zeroHash, author.address, 1n, expiresAt, signature],
      { account: ctx.relayer.account }
    ), /InvalidAuthorizationSigner/);
    await assert.rejects(ctx.registry.write.anchorSignedCommit(
      [commitHash, evidenceRoot, zeroHash, zeroHash, author.address, 1n, expiresAt, "0x"],
      { account: ctx.relayer.account }
    ), /ECDSAInvalidSignatureLength/);
    await assert.rejects(ctx.registry.write.anchorSignedCommit(
      [commitHash, evidenceRoot, zeroHash, zeroHash, author.address, 1n, expiresAt, "0x"],
      { account: ctx.outsider.account }
    ), /AccessControlUnauthorizedAccount/);
  });

  it("anchors a root with distinct author/relayer identities and emits CommitAnchored", async () => {
    const ctx = await fixture();
    const root = await anchorRoot(ctx, "root");
    assert.equal(await ctx.registry.read.getCommitAuthor([root.commitHash]), getAddress(root.author.address));
    assert.equal(await ctx.registry.read.getCommitRelayer([root.commitHash]), getAddress(ctx.relayer.account.address));
    assert.equal(await ctx.registry.read.getCommitReviewer([root.commitHash]), zeroAddress);
    assert.equal(await ctx.registry.read.getCommitStatus([root.commitHash]), 0);
    assert.equal(await ctx.registry.read.usedNonces([root.author.address, 0n]), true);
    const receipt = await ctx.publicClient.getTransactionReceipt({ hash: root.tx });
    const events = parseEventLogs({ abi: ctx.registry.abi, logs: receipt.logs, eventName: "CommitAnchored" });
    assert.equal(events.length, 1);
    assert.equal((events[0] as { args: { commitHash: Hex } } | undefined)?.args.commitHash, root.commitHash);
  });

  it("anchors a one-parent fork and rejects absent or second parents", async () => {
    const ctx = await fixture();
    const root = await anchorRoot(ctx, "fork-parent");
    const author = privateKeyToAccount(generatePrivateKey());
    const commitHash = digest("fork:commit");
    const evidenceRoot = digest("fork:evidence");
    const expiresAt = await future(ctx.publicClient);
    const signature = await signCommit(
      ctx.chainId, ctx.registry.address, author, commitHash, evidenceRoot, 0n, expiresAt, root.commitHash
    );
    await ctx.registry.write.anchorSignedCommit(
      [commitHash, evidenceRoot, root.commitHash, zeroHash, author.address, 0n, expiresAt, signature],
      { account: ctx.relayer.account }
    );
    assert.deepEqual(await ctx.registry.read.getCommitParents([commitHash]), [root.commitHash, zeroHash]);
    await assert.rejects(ctx.registry.write.anchorSignedCommit(
      [digest("bad-parent"), evidenceRoot, digest("missing"), zeroHash, author.address, 2n, expiresAt, signature],
      { account: ctx.relayer.account }
    ), /MissingParent/);
    await assert.rejects(ctx.registry.write.anchorSignedCommit(
      [digest("two-parent"), evidenceRoot, root.commitHash, root.commitHash, author.address, 3n, expiresAt, signature],
      { account: ctx.relayer.account }
    ), /InvalidParentArrangement/);
  });

  it("binds V2 root and fork authorizations to the exact submitted parent pair", async () => {
    const ctx = await fixture();
    const firstParent = await anchorRoot(ctx, "binding-parent-a");
    const secondParent = await anchorRoot(ctx, "binding-parent-b");
    const author = privateKeyToAccount(generatePrivateKey());
    const evidenceRoot = digest("binding:evidence");
    const expiresAt = await future(ctx.publicClient);

    const rootHash = digest("binding:root");
    const rootSignature = await signCommit(
      ctx.chainId, ctx.registry.address, author, rootHash, evidenceRoot, 0n, expiresAt
    );
    await assert.rejects(ctx.registry.write.anchorSignedCommit(
      [rootHash, evidenceRoot, firstParent.commitHash, zeroHash, author.address, 0n, expiresAt, rootSignature],
      { account: ctx.relayer.account }
    ), /InvalidAuthorizationSigner/);

    const forkHash = digest("binding:fork");
    const forkSignature = await signCommit(
      ctx.chainId, ctx.registry.address, author, forkHash, evidenceRoot, 1n, expiresAt, firstParent.commitHash
    );
    await assert.rejects(ctx.registry.write.anchorSignedCommit(
      [forkHash, evidenceRoot, secondParent.commitHash, zeroHash, author.address, 1n, expiresAt, forkSignature],
      { account: ctx.relayer.account }
    ), /InvalidAuthorizationSigner/);
    await ctx.registry.write.anchorSignedCommit(
      [forkHash, evidenceRoot, firstParent.commitHash, zeroHash, author.address, 1n, expiresAt, forkSignature],
      { account: ctx.relayer.account }
    );
  });

  it("binds V2 merges to a canonical parent pair and rejects replacement or swapping", async () => {
    const ctx = await fixture();
    const parents = await Promise.all([
      anchorRoot(ctx, "merge-binding-a"),
      anchorRoot(ctx, "merge-binding-b"),
      anchorRoot(ctx, "merge-binding-c")
    ]);
    const [parentA, parentB] = [parents[0]!.commitHash, parents[1]!.commitHash].sort() as [Hex, Hex];
    const replacement = parents[2]!.commitHash;
    const author = privateKeyToAccount(generatePrivateKey());
    const mergeHash = digest("merge-binding:commit");
    const evidenceRoot = digest("merge-binding:evidence");
    const expiresAt = await future(ctx.publicClient);
    const signature = await signCommit(
      ctx.chainId, ctx.registry.address, author, mergeHash, evidenceRoot, 0n, expiresAt, parentA, parentB
    );
    const [otherA, otherB] = [parentA, replacement].sort() as [Hex, Hex];
    await assert.rejects(ctx.registry.write.anchorReviewedMerge(
      [mergeHash, evidenceRoot, otherA, otherB, author.address, 0n, expiresAt, signature],
      { account: ctx.reviewer.account }
    ), /InvalidAuthorizationSigner/);
    await assert.rejects(ctx.registry.write.anchorReviewedMerge(
      [mergeHash, evidenceRoot, parentB, parentA, author.address, 0n, expiresAt, signature],
      { account: ctx.reviewer.account }
    ), /NonCanonicalParentOrder/);
    await ctx.registry.write.anchorReviewedMerge(
      [mergeHash, evidenceRoot, parentA, parentB, author.address, 0n, expiresAt, signature],
      { account: ctx.reviewer.account }
    );
  });

  it("independently rejects the legacy V1 commit type and V2 commits signed for domain version 1", async () => {
    const ctx = await fixture();
    const author = privateKeyToAccount(generatePrivateKey());
    const commitHash = digest("legacy-v1:commit");
    const evidenceRoot = digest("legacy-v1:evidence");
    const expiresAt = await future(ctx.publicClient);
    const signature = await signV1Commit(
      ctx.chainId, ctx.registry.address, author, commitHash, evidenceRoot, 0n, expiresAt
    );
    await assert.rejects(ctx.registry.write.anchorSignedCommit(
      [commitHash, evidenceRoot, zeroHash, zeroHash, author.address, 0n, expiresAt, signature],
      { account: ctx.relayer.account }
    ), /InvalidAuthorizationSigner/);
    assert.equal(await ctx.registry.read.usedNonces([author.address, 0n]), false);
    const wrongDomainHash = digest("wrong-domain-v1:commit");
    const wrongDomainSignature = await signV2CommitWithDomainV1(
      ctx.chainId, ctx.registry.address, author, wrongDomainHash, evidenceRoot, 1n, expiresAt
    );
    await assert.rejects(ctx.registry.write.anchorSignedCommit(
      [wrongDomainHash, evidenceRoot, zeroHash, zeroHash, author.address, 1n, expiresAt, wrongDomainSignature],
      { account: ctx.relayer.account }
    ), /InvalidAuthorizationSigner/);
    assert.equal(await ctx.registry.read.usedNonces([author.address, 1n]), false);
  });

  it("enforces chain, verifying-contract, expiry, nonce replay, and duplicate commit protection", async () => {
    const ctx = await fixture();
    const author = privateKeyToAccount(generatePrivateKey());
    const commitHash = digest("replay:commit");
    const evidenceRoot = digest("replay:evidence");
    const expiresAt = await future(ctx.publicClient);
    const wrongChain = await signCommit(ctx.chainId + 1, ctx.registry.address, author, commitHash, evidenceRoot, 7n, expiresAt);
    await assert.rejects(ctx.registry.write.anchorSignedCommit(
      [commitHash, evidenceRoot, zeroHash, zeroHash, author.address, 7n, expiresAt, wrongChain], { account: ctx.relayer.account }
    ), /InvalidAuthorizationSigner/);
    assert.equal(await ctx.registry.read.usedNonces([author.address, 7n]), false);
    const wrongContract = await signCommit(ctx.chainId, ctx.outsider.account.address, author, commitHash, evidenceRoot, 7n, expiresAt);
    await assert.rejects(ctx.registry.write.anchorSignedCommit(
      [commitHash, evidenceRoot, zeroHash, zeroHash, author.address, 7n, expiresAt, wrongContract], { account: ctx.relayer.account }
    ), /InvalidAuthorizationSigner/);
    const expired = await signCommit(ctx.chainId, ctx.registry.address, author, commitHash, evidenceRoot, 7n, 1n);
    await assert.rejects(ctx.registry.write.anchorSignedCommit(
      [commitHash, evidenceRoot, zeroHash, zeroHash, author.address, 7n, 1n, expired], { account: ctx.relayer.account }
    ), /SignatureExpired/);
    const valid = await signCommit(ctx.chainId, ctx.registry.address, author, commitHash, evidenceRoot, 7n, expiresAt);
    await ctx.registry.write.anchorSignedCommit(
      [commitHash, evidenceRoot, zeroHash, zeroHash, author.address, 7n, expiresAt, valid], { account: ctx.relayer.account }
    );
    await assert.rejects(ctx.registry.write.anchorSignedCommit(
      [digest("other"), evidenceRoot, zeroHash, zeroHash, author.address, 7n, expiresAt, valid], { account: ctx.relayer.account }
    ), /NonceAlreadyUsed/);
    await assert.rejects(ctx.registry.write.anchorSignedCommit(
      [commitHash, evidenceRoot, zeroHash, zeroHash, author.address, 8n, expiresAt, valid], { account: ctx.relayer.account }
    ), /CommitAlreadyAnchored/);
  });

  it("rejects zero hashes and an invalid initial admin", async () => {
    const ctx = await fixture();
    const author = privateKeyToAccount(generatePrivateKey());
    const expiresAt = await future(ctx.publicClient);
    const sig = await signCommit(ctx.chainId, ctx.registry.address, author, zeroHash, digest("e"), 0n, expiresAt);
    await assert.rejects(ctx.registry.write.anchorSignedCommit(
      [zeroHash, digest("e"), zeroHash, zeroHash, author.address, 0n, expiresAt, sig], { account: ctx.relayer.account }
    ), /ZeroCommitHash/);
    const zeroEvidenceCommit = digest("zero-evidence-commit");
    await assert.rejects(ctx.registry.write.anchorSignedCommit(
      [zeroEvidenceCommit, zeroHash, zeroHash, zeroHash, author.address, 1n, expiresAt,
        await signCommit(ctx.chainId, ctx.registry.address, author, zeroEvidenceCommit, zeroHash, 1n, expiresAt)],
      { account: ctx.relayer.account }
    ), /ZeroEvidenceRoot/);
    await assert.rejects(viem.deployContract("RealityRegistry", [zeroAddress]), /ZeroAddress/);
  });

  it("anchors reviewer-only merges and atomically supersedes both distinct parents", async () => {
    const ctx = await fixture();
    const a = await anchorRoot(ctx, "merge-a");
    const b = await anchorRoot(ctx, "merge-b");
    const author = privateKeyToAccount(generatePrivateKey());
    const mergeHash = digest("merge:commit");
    const evidenceRoot = digest("merge:evidence");
    const expiresAt = await future(ctx.publicClient);
    const [parentA, parentB] = [a.commitHash, b.commitHash].sort() as [Hex, Hex];
    const signature = await signCommit(
      ctx.chainId, ctx.registry.address, author, mergeHash, evidenceRoot, 0n, expiresAt, parentA, parentB
    );
    await assert.rejects(ctx.registry.write.anchorReviewedMerge(
      [mergeHash, evidenceRoot, parentA, parentB, author.address, 0n, expiresAt, signature], { account: ctx.relayer.account }
    ), /AccessControlUnauthorizedAccount/);
    const tx = await ctx.registry.write.anchorReviewedMerge(
      [mergeHash, evidenceRoot, parentA, parentB, author.address, 0n, expiresAt, signature], { account: ctx.reviewer.account }
    );
    const receipt = await ctx.publicClient.waitForTransactionReceipt({ hash: tx });
    assert.equal(await ctx.registry.read.getCommitStatus([mergeHash]), 2);
    assert.equal(await ctx.registry.read.getCommitStatus([parentA]), 3);
    assert.equal(await ctx.registry.read.getCommitStatus([parentB]), 3);
    assert.equal(await ctx.registry.read.getCommitReviewer([mergeHash]), getAddress(ctx.reviewer.account.address));
    assert.equal(parseEventLogs({ abi: ctx.registry.abi, logs: receipt.logs, eventName: "CommitMerged" }).length, 1);
  });

  it("rejects duplicate, missing, and superseded merge parents", async () => {
    const ctx = await fixture();
    const a = await anchorRoot(ctx, "rules-a");
    const b = await anchorRoot(ctx, "rules-b");
    const author = privateKeyToAccount(generatePrivateKey());
    const expiresAt = await future(ctx.publicClient);
    const evidenceRoot = digest("rules:evidence");
    const sign = (hash: Hex, nonce: bigint, parentA: Hex = zeroHash, parentB: Hex = zeroHash) =>
      signCommit(ctx.chainId, ctx.registry.address, author, hash, evidenceRoot, nonce, expiresAt, parentA, parentB);
    const dupHash = digest("dup-merge");
    await assert.rejects(ctx.registry.write.anchorReviewedMerge(
      [dupHash, evidenceRoot, a.commitHash, a.commitHash, author.address, 0n, expiresAt, await sign(dupHash, 0n)], { account: ctx.reviewer.account }
    ), /DuplicateParents/);
    const missingHash = digest("missing-merge");
    await assert.rejects(ctx.registry.write.anchorReviewedMerge(
      [missingHash, evidenceRoot, a.commitHash, digest("missing-parent"), author.address, 1n, expiresAt, await sign(missingHash, 1n)], { account: ctx.reviewer.account }
    ), /MissingParent/);
    const firstMerge = digest("first-merge");
    const [firstParentA, firstParentB] = [a.commitHash, b.commitHash].sort() as [Hex, Hex];
    await ctx.registry.write.anchorReviewedMerge(
      [firstMerge, evidenceRoot, firstParentA, firstParentB, author.address, 2n, expiresAt,
        await sign(firstMerge, 2n, firstParentA, firstParentB)], { account: ctx.reviewer.account }
    );
    const c = await anchorRoot(ctx, "rules-c");
    const nextHash = digest("next-merge");
    await assert.rejects(ctx.registry.write.anchorReviewedMerge(
      [nextHash, evidenceRoot, a.commitHash, c.commitHash, author.address, 3n, expiresAt, await sign(nextHash, 3n)], { account: ctx.reviewer.account }
    ), /ParentSuperseded/);
    const forkHash = digest("superseded-parent-fork");
    await assert.rejects(ctx.registry.write.anchorSignedCommit(
      [forkHash, evidenceRoot, a.commitHash, zeroHash, author.address, 4n, expiresAt,
        await signCommit(ctx.chainId, ctx.registry.address, author, forkHash, evidenceRoot, 4n, expiresAt, a.commitHash)],
      { account: ctx.relayer.account }
    ), /ParentSuperseded/);
  });

  it("anchors signed challenges, increments counts, changes Active only, and emits provenance", async () => {
    const ctx = await fixture();
    const root = await anchorRoot(ctx, "challenge-target");
    const challenger = privateKeyToAccount(generatePrivateKey());
    const challengeHash = digest("challenge:one");
    const evidenceRoot = digest("challenge:evidence");
    const expiresAt = await future(ctx.publicClient);
    const signature = await signChallenge(ctx.chainId, ctx.registry.address, challenger, challengeHash, root.commitHash, evidenceRoot, 9n, expiresAt);
    const tx = await ctx.registry.write.anchorSignedChallenge(
      [challengeHash, root.commitHash, evidenceRoot, challenger.address, 9n, expiresAt, signature], { account: ctx.relayer.account }
    );
    const receipt = await ctx.publicClient.waitForTransactionReceipt({ hash: tx });
    assert.equal(await ctx.registry.read.getCommitStatus([root.commitHash]), 1);
    assert.equal(await ctx.registry.read.challengeCount([root.commitHash]), 1n);
    assert.equal(await ctx.registry.read.usedChallengeHashes([challengeHash]), true);
    const events = parseEventLogs({ abi: ctx.registry.abi, logs: receipt.logs, eventName: "CommitChallenged" });
    const challengeArgs = (events[0] as { args: { challenger: Address; relayer: Address } } | undefined)?.args;
    assert.equal(challengeArgs?.challenger, getAddress(challenger.address));
    assert.equal(challengeArgs?.relayer, getAddress(ctx.relayer.account.address));
  });

  it("rejects challenge replay, wrong target binding, missing targets, and superseded targets", async () => {
    const ctx = await fixture();
    const a = await anchorRoot(ctx, "challenge-a");
    const b = await anchorRoot(ctx, "challenge-b");
    const challenger = privateKeyToAccount(generatePrivateKey());
    const evidenceRoot = digest("challenge:rules:evidence");
    const expiresAt = await future(ctx.publicClient);
    const challengeHash = digest("challenge:rules");
    const signature = await signChallenge(ctx.chainId, ctx.registry.address, challenger, challengeHash, a.commitHash, evidenceRoot, 0n, expiresAt);
    await assert.rejects(ctx.registry.write.anchorSignedChallenge(
      [challengeHash, b.commitHash, evidenceRoot, challenger.address, 0n, expiresAt, signature], { account: ctx.relayer.account }
    ), /InvalidAuthorizationSigner/);
    await ctx.registry.write.anchorSignedChallenge(
      [challengeHash, a.commitHash, evidenceRoot, challenger.address, 0n, expiresAt, signature], { account: ctx.relayer.account }
    );
    await assert.rejects(ctx.registry.write.anchorSignedChallenge(
      [challengeHash, a.commitHash, evidenceRoot, challenger.address, 1n, expiresAt, signature], { account: ctx.relayer.account }
    ), /ChallengeAlreadyAnchored/);
    const missingHash = digest("challenge:missing");
    const missingTarget = digest("missing-target");
    await assert.rejects(ctx.registry.write.anchorSignedChallenge(
      [missingHash, missingTarget, evidenceRoot, challenger.address, 2n, expiresAt,
        await signChallenge(ctx.chainId, ctx.registry.address, challenger, missingHash, missingTarget, evidenceRoot, 2n, expiresAt)],
      { account: ctx.relayer.account }
    ), /TargetCommitMissing/);
    const mergeAuthor = privateKeyToAccount(generatePrivateKey());
    const mergeHash = digest("challenge:merge");
    const mergeEvidence = digest("challenge:merge:evidence");
    const [mergeParentA, mergeParentB] = [a.commitHash, b.commitHash].sort() as [Hex, Hex];
    await ctx.registry.write.anchorReviewedMerge(
      [mergeHash, mergeEvidence, mergeParentA, mergeParentB, mergeAuthor.address, 0n, expiresAt,
        await signCommit(
          ctx.chainId, ctx.registry.address, mergeAuthor, mergeHash, mergeEvidence, 0n, expiresAt, mergeParentA, mergeParentB
        )],
      { account: ctx.reviewer.account }
    );
    const supersededChallenge = digest("challenge:superseded");
    await assert.rejects(ctx.registry.write.anchorSignedChallenge(
      [supersededChallenge, a.commitHash, evidenceRoot, challenger.address, 3n, expiresAt,
        await signChallenge(ctx.chainId, ctx.registry.address, challenger, supersededChallenge, a.commitHash, evidenceRoot, 3n, expiresAt)],
      { account: ctx.relayer.account }
    ), /TargetSuperseded/);
  });

  it("shares each signer's nonce space across commit and challenge authorization types", async () => {
    const ctx = await fixture();
    const target = await anchorRoot(ctx, "shared-nonce-target");
    const signer = privateKeyToAccount(generatePrivateKey());
    const expiresAt = await future(ctx.publicClient);
    const challengeHash = digest("shared-nonce-challenge");
    const challengeEvidence = digest("shared-nonce-evidence");
    await ctx.registry.write.anchorSignedChallenge(
      [challengeHash, target.commitHash, challengeEvidence, signer.address, 44n, expiresAt,
        await signChallenge(ctx.chainId, ctx.registry.address, signer, challengeHash, target.commitHash, challengeEvidence, 44n, expiresAt)],
      { account: ctx.relayer.account }
    );
    const commitHash = digest("shared-nonce-commit");
    const commitEvidence = digest("shared-nonce-commit-evidence");
    await assert.rejects(ctx.registry.write.anchorSignedCommit(
      [commitHash, commitEvidence, zeroHash, zeroHash, signer.address, 44n, expiresAt,
        await signCommit(ctx.chainId, ctx.registry.address, signer, commitHash, commitEvidence, 44n, expiresAt)],
      { account: ctx.relayer.account }
    ), /NonceAlreadyUsed/);
  });

  it("reverts read methods for unknown commits", async () => {
    const ctx = await fixture();
    assert.equal(await ctx.registry.read.commitExists([digest("unknown")]), false);
    await assert.rejects(ctx.registry.read.getCommit([digest("unknown")]), /TargetCommitMissing/);
  });
});
