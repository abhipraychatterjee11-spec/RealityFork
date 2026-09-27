# Five-minute demo

The executable synthetic Road A17 workflow, mock fallback, local Hardhat EVM setup, speaking roles, failure responses and honest-claims checklist are maintained in [`demo-runbook.md`](demo-runbook.md).

Quick fallback:

```powershell
$demoTokenBytes = New-Object byte[] 32
[Security.Cryptography.RandomNumberGenerator]::Fill($demoTokenBytes)
$env:REVIEWER_API_TOKEN = [Convert]::ToHexString($demoTokenBytes)
pnpm demo:mock
```

The output must say `SIMULATED` and `mock=true`. End every version of the demo with: **Anchoring proves this record history, not that any real-world observation is true.**
