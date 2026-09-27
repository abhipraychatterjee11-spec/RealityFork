import { runDemoWorkflow } from "../src/demo.js";
import { prepareLocalEvmDemo } from "../src/demo-evm.js";
import { MockBlockchainAdapter } from "../src/blockchain/mock.js";

const mode = process.argv[2];
if (mode !== "mock" && mode !== "evm") throw new Error("Usage: demo.ts <mock|evm>");
const reviewerToken = process.env.REVIEWER_API_TOKEN;
if (!reviewerToken) throw new Error("REVIEWER_AUTH_CONFIGURATION_MISSING: set REVIEWER_API_TOKEN to a 32+ byte local secret");

if (mode === "mock") {
  const chainId = Number(process.env.SIGNATURE_CHAIN_ID ?? 31_337);
  const verifyingContract = process.env.REGISTRY_CONTRACT_ADDRESS ?? "0x1000000000000000000000000000000000000001";
  await runDemoWorkflow({
    adapter: new MockBlockchainAdapter({ chainId, contractAddress: verifyingContract as `0x${string}` }),
    signatureDomain: { chainId, verifyingContract },
    reviewerToken,
    write: console.log
  });
} else {
  const prepared = await prepareLocalEvmDemo(process.env);
  await runDemoWorkflow({
    ...prepared,
    reviewerToken,
    write: console.log
  });
}
