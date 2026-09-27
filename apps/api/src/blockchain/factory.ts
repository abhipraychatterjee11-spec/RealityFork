import type { BlockchainAdapter } from "./types.js";
import { MockBlockchainAdapter } from "./mock.js";
import { loadEvmAdapterConfig } from "./config.js";
import { EvmBlockchainAdapter } from "./evm.js";

export async function createBlockchainAdapterFromEnvironment(
  env: NodeJS.ProcessEnv = process.env
): Promise<BlockchainAdapter> {
  const mode = env.BLOCKCHAIN_ADAPTER_MODE ?? "mock";
  if (mode === "mock") return new MockBlockchainAdapter();
  if (mode === "evm") return EvmBlockchainAdapter.create(await loadEvmAdapterConfig(env));
  throw new Error("BLOCKCHAIN_ADAPTER_MODE must be 'mock' or 'evm'");
}
