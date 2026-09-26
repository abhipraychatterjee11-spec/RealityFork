import type { CreateCommitInput, Evidence, RealityCommit } from "@realityfork/shared";

const clamp = (value: number) => Math.max(0, Math.min(1, value));

export function scoreEvidence(items: Evidence[]): number {
  const scores = items.map((item) => {
    const metadata = Number(Boolean(item.capturedAt)) + Number(item.latitude !== undefined) + Number(Boolean(item.deviceSignature));
    const metadataScore = metadata / 3;
    const mediaRisk = 1 - (item.aiRiskScore ?? 0.35);
    const kindWeight = item.kind === "sensor" ? 0.95 : item.kind === "document" ? 0.85 : 0.75;
    return clamp(metadataScore * 0.4 + mediaRisk * 0.35 + kindWeight * 0.25);
  });
  return Number((scores.reduce((sum, score) => sum + score, 0) / scores.length).toFixed(3));
}

export function initialReputation(role: CreateCommitInput["authorRole"]): number {
  return role === "official" ? 0.72 : role === "sensor" ? 0.8 : role === "reviewer" ? 0.68 : 0.5;
}

export function detectContradictions(input: CreateCommitInput, existing: RealityCommit[]): string[] {
  const flags: string[] = [];
  for (const commit of existing) {
    if (commit.claim.subjectId !== input.claim.subjectId || commit.claim.field !== input.claim.field) continue;
    if (commit.claim.value.toLowerCase() !== input.claim.value.toLowerCase()) {
      flags.push(`Value conflicts with commit ${commit.id}`);
    }
    const delta = Math.abs(Date.parse(commit.claim.observedAt) - Date.parse(input.claim.observedAt));
    if (delta < 60 * 60 * 1000 && commit.claim.value !== input.claim.value) {
      flags.push(`Conflicting observations within one hour of commit ${commit.id}`);
    }
  }
  return [...new Set(flags)];
}

