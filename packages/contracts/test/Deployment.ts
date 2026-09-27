import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { network } from "hardhat";
import { getAddress, isAddress, zeroAddress, type Address, type Hex } from "viem";
import { deployRealityRegistry } from "../scripts/deployment.js";

describe("local deployment workflow", () => {
  it("validates roles, deploys, exports ABI/manifest, assigns roles, and refuses overwrite", async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), "realityfork-deployment-"));
    try {
      const connection = await network.create();
      const wallets = await connection.viem.getWalletClients();
      const manifestDirectory = join(outputRoot, "deployments");
      const abiOutputPath = join(outputRoot, "abi", "RealityRegistry.json");

      await assert.rejects(
        deployRealityRegistry(connection, {
          administratorAddress: wallets[0]!.account.address,
          relayerAddress: zeroAddress,
          reviewerAddress: wallets[2]!.account.address,
          manifestDirectory,
          abiOutputPath
        }),
        /Relayer address must not be the zero address/
      );
      await assert.rejects(
        deployRealityRegistry(connection, {
          administratorAddress: wallets[0]!.account.address,
          relayerAddress: "not-an-address",
          reviewerAddress: wallets[2]!.account.address,
          manifestDirectory,
          abiOutputPath
        }),
        /Relayer address must be a valid EVM address/
      );

      const result = await deployRealityRegistry(connection, { manifestDirectory, abiOutputPath });
      const manifest = JSON.parse(await readFile(result.manifestPath, "utf8"));
      const abi = JSON.parse(await readFile(result.abiOutputPath, "utf8")) as Array<{ type: string; name?: string }>;
      const publicClient = await connection.viem.getPublicClient();

      assert.equal(manifest.contractAddress, getAddress(result.contract.address));
      assert.equal(manifest.chainId, await publicClient.getChainId());
      assert.equal(manifest.eip712Domain.version, "2");
      assert.equal(manifest.eip712Domain.verifyingContract, manifest.contractAddress);
      assert.equal(isAddress(manifest.contractAddress), true);
      assert.match(manifest.deploymentTransactionHash, /^0x[a-fA-F0-9]{64}$/);
      assert.ok(BigInt(manifest.deploymentBlockNumber) >= 0n);

      const functionNames = new Set(abi.filter((item) => item.type === "function").map((item) => item.name));
      for (const required of [
        "anchorSignedCommit", "anchorSignedChallenge", "anchorReviewedMerge", "getCommit", "usedNonces"
      ]) {
        assert.equal(functionNames.has(required), true, `ABI is missing ${required}`);
      }

      const adminRole = await result.contract.read.DEFAULT_ADMIN_ROLE();
      const relayerRole = await result.contract.read.RELAYER_ROLE();
      const reviewerRole = await result.contract.read.REVIEWER_ROLE();
      assert.equal(await result.contract.read.hasRole([adminRole, manifest.administratorAddress]), true);
      assert.equal(await result.contract.read.hasRole([relayerRole, manifest.relayerAddress]), true);
      assert.equal(await result.contract.read.hasRole([reviewerRole, manifest.reviewerAddress]), true);
      const domain = await result.contract.read.eip712Domain() as readonly [Hex, string, string, bigint, Address, Hex, readonly bigint[]];
      assert.equal(domain[1], "RealityFork");
      assert.equal(domain[2], "2");

      const originalManifest = await readFile(result.manifestPath, "utf8");
      await assert.rejects(
        deployRealityRegistry(connection, { manifestDirectory, abiOutputPath }),
        /Deployment manifest already exists/
      );
      assert.equal(await readFile(result.manifestPath, "utf8"), originalManifest);
    } finally {
      await rm(outputRoot, { recursive: true, force: true });
    }
  });
});
