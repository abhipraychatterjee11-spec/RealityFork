# Security and false-claim controls

## Threats considered

| Threat | MVP control | Production improvement |
|---|---|---|
| AI-generated road photo | Record AI-risk output, metadata completeness and device signature; route suspicious evidence to review | C2PA verification, model ensemble, camera attestation and reverse-image search |
| Old photo presented as new | Capture timestamp and compare it with upload time; flag missing EXIF | Trusted capture application with signed timestamp |
| Correct photo from wrong place | Optional GPS check and map confirmation | Device attestation, geofence and nearby corroborating reports |
| Coordinated false reports | Rate limit identities and expose source history | Sybil-resistant credentials and anomaly detection |
| Corrupt reviewer | Preserve every decision and allow challenge of a merge | Multi-party approval and rotating civic review panels |
| Sensitive location leakage | Minimize public precision and keep raw files off-chain | Consent policies, encryption and role-based access |
| Blockchain spam | API validation and controlled testnet relayer | Deposits, quotas or sponsored transactions with abuse rules |

## Important limitation

AI detection produces a risk signal, not proof. The system must never automatically declare a claim true or false from one model score. It should combine provenance, metadata, independent evidence, source history and human review.

