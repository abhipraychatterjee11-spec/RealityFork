import { network } from "hardhat";
import { deployRealityRegistry } from "./deployment.js";

const connection = await network.create();
const optionalAddress = (value: string | undefined) => value?.trim() || undefined;
const result = await deployRealityRegistry(connection, {
  administratorAddress: optionalAddress(process.env.CONTRACT_ADMIN_ADDRESS),
  relayerAddress: optionalAddress(process.env.RELAYER_ADDRESS),
  reviewerAddress: optionalAddress(process.env.REVIEWER_ADDRESS)
});

const { manifest } = result;
console.log(`Network: ${manifest.networkName}`);
console.log(`Chain ID: ${manifest.chainId}`);
console.log(`Contract: ${manifest.contractAddress}`);
console.log(`Administrator: ${manifest.administratorAddress}`);
console.log(`Relayer: ${manifest.relayerAddress}`);
console.log(`Reviewer: ${manifest.reviewerAddress}`);
console.log(`Deployment transaction: ${manifest.deploymentTransactionHash}`);
console.log(`EIP-712 domain: ${JSON.stringify(manifest.eip712Domain)}`);
console.log(`ABI export: ${result.abiOutputPath}`);
console.log(`Manifest: ${result.manifestPath}`);
