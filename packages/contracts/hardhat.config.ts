import hardhatToolboxViemPlugin from "@nomicfoundation/hardhat-toolbox-viem";
import { defineConfig } from "hardhat/config";

export default defineConfig({
  plugins: [hardhatToolboxViemPlugin],
  solidity: {
    profiles: {
      default: { version: "0.8.28" },
      production: {
        version: "0.8.28",
        settings: { optimizer: { enabled: true, runs: 200 } }
      }
    }
  },
  networks: {
    hardhatMainnet: { type: "edr-simulated", chainType: "l1" },
    localhost: { type: "http", url: process.env.CHAIN_RPC_URL ?? "http://127.0.0.1:8545" }
  }
});
