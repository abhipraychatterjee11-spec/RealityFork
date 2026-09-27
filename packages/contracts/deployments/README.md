# Local deployment manifests

`pnpm contracts:deploy:local` creates `<chainId>.json` here after a successful local deployment and role assignment. Each manifest is machine-readable deployment provenance for the future API and frontend.

Generated `*.json` manifests are intentionally ignored by Git because a local Hardhat chain is ephemeral and its address becomes invalid when that chain is restarted. Do not commit an ephemeral address as though it were a shared deployment. The directory documentation and `.gitkeep` are committed.

The stable ABI at `packages/contracts/abi/RealityRegistry.json` is generated from the compiled contract and **should be committed** whenever the Solidity interface changes. Regenerate it with `pnpm contracts:export:abi`.

The deployment command refuses to overwrite an existing chain-ID manifest. Remove or archive a stale local manifest deliberately only after confirming its chain is no longer being used.
