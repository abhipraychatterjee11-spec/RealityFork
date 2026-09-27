import { createPublicClient, decodeEventLog, http, type Abi, type Hex } from "viem";
import { loadEvmAdapterConfig } from "./blockchain/config.js";
import { EvmBlockchainAdapter } from "./blockchain/evm.js";
import type { DemoProofReader, DemoRunOptions } from "./demo.js";

export async function prepareLocalEvmDemo(env: NodeJS.ProcessEnv = process.env): Promise<Pick<DemoRunOptions, "adapter" | "signatureDomain" | "proofReader">> {
  const config = await loadEvmAdapterConfig(env);
  const adapter = await EvmBlockchainAdapter.create(config);
  const client = createPublicClient({ transport: http(config.rpcUrl) });
  const proofReader: DemoProofReader = {
    async read(transactionHash) {
      const receipt = await client.getTransactionReceipt({ hash: transactionHash as Hex });
      const events = receipt.logs.flatMap((log) => {
        try {
          const decoded = decodeEventLog({ abi: config.abi as Abi, data: log.data, topics: log.topics });
          return typeof decoded.eventName === "string" ? [decoded.eventName] : [];
        } catch { return []; }
      });
      return { transactionHash, blockNumber: receipt.blockNumber.toString(10), status: receipt.status, events };
    }
  };
  return {
    adapter,
    signatureDomain: { chainId: config.chainId, verifyingContract: config.contractAddress },
    proofReader
  };
}
