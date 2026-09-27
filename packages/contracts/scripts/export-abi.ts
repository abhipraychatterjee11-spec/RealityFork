import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { writeAbiExport } from "./deployment.js";

const packageRoot = resolve(import.meta.dirname, "..");
const artifactPath = resolve(packageRoot, "artifacts/contracts/RealityRegistry.sol/RealityRegistry.json");
const artifact = JSON.parse(await readFile(artifactPath, "utf8")) as { abi?: unknown[] };
if (!Array.isArray(artifact.abi)) throw new Error(`Hardhat artifact has no ABI: ${artifactPath}`);
const outputPath = resolve(packageRoot, "abi/RealityRegistry.json");
await writeAbiExport(artifact.abi, outputPath);
console.log(`Exported RealityRegistry ABI to ${outputPath}`);
