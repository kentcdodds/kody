import { packageNameLeafPattern } from '#worker/package-registry/package-name.ts'

/** Cap alternate probes so a packed account cannot spin forever. */
export const communityForkAlternateLeafMaxAttempts = 50

/**
 * Next candidate leaves when the preferred listing leaf is taken by an
 * unrelated saved package (no `community_forks` row for this listing at that
 * leaf). `demo` → `demo-2`, `demo-3`, …
 */
export function communityForkAlternateLeafCandidates(
	preferredLeaf: string,
	maxAttempts = communityForkAlternateLeafMaxAttempts,
): Array<string> {
	const candidates: Array<string> = []
	for (let n = 2; n < 2 + maxAttempts; n++) {
		const candidate = `${preferredLeaf}-${n}`
		if (!packageNameLeafPattern.test(candidate)) continue
		candidates.push(candidate)
	}
	return candidates
}

/**
 * Pick the first free alternate leaf. `reservedLeaves` covers known fork
 * targets; `isLeafTaken` probes live saved packages (and anything else the
 * caller cares about).
 */
export async function resolveCommunityForkAlternateLeaf(input: {
	preferredLeaf: string
	reservedLeaves: ReadonlySet<string>
	isLeafTaken: (leaf: string) => Promise<boolean>
	maxAttempts?: number
}): Promise<string | null> {
	for (const candidate of communityForkAlternateLeafCandidates(
		input.preferredLeaf,
		input.maxAttempts,
	)) {
		if (input.reservedLeaves.has(candidate)) continue
		if (await input.isLeafTaken(candidate)) continue
		return candidate
	}
	return null
}
