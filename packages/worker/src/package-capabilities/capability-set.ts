import { sha256Hex } from '@kody-internal/shared/sha256.ts'

/**
 * Why a package reaches a credential. `need` fills a declared
 * `kody.credentials` key, `mount` a declared `kody.secretMounts` name,
 * `grant` is a credential the owner granted this package, and `package` is
 * the package's own package-scoped credential.
 */
export type CapabilityCredentialSource = 'need' | 'mount' | 'grant' | 'package'

/**
 * One reachable surface in a package's resolved capability set.
 * Fingerprints ignore `via` and display-only fields (`name`, `source`,
 * `needKey`).
 */
export type CapabilitySetEntry = {
	kind: 'credential' | 'storage'
	/** Stable credential id (#3442). Required when kind is credential. */
	credentialId?: string
	/** Display name only; never part of the fingerprint. */
	name?: string
	/** Display only: how the package reaches this credential. */
	source?: CapabilityCredentialSource
	/** Display only: the declared `kody.credentials` key a `need` fills. */
	needKey?: string
	credentialKind?: string
	hosts: Array<string>
	placement?: string | null
	/** Package path that reaches this entry (root first). */
	via: Array<string>
	/** Storage grant package id when kind is storage. */
	storageId?: string
}

export type CapabilitySet = {
	entries: Array<CapabilitySetEntry>
	fingerprint: string
}

type CanonicalFingerprintEntry = {
	kind: CapabilitySetEntry['kind']
	credentialId?: string
	credentialKind?: string
	hosts: Array<string>
	placement?: string | null
	storageId?: string
}

function sortHosts(hosts: ReadonlyArray<string>) {
	return [...hosts].map((host) => host.trim().toLowerCase()).sort()
}

function toCanonicalEntry(
	entry: CapabilitySetEntry,
): CanonicalFingerprintEntry {
	if (entry.kind === 'credential') {
		return {
			kind: 'credential',
			credentialId: entry.credentialId,
			credentialKind: entry.credentialKind ?? 'secret',
			hosts: sortHosts(entry.hosts),
			placement: entry.placement ?? null,
		}
	}
	return {
		kind: 'storage',
		storageId: entry.storageId,
		hosts: [],
	}
}

function canonicalKey(entry: CanonicalFingerprintEntry) {
	return JSON.stringify(entry)
}

/**
 * Deduplicate by fingerprint identity, prefer longer `via` paths when merging
 * display rows so the UI can show how a credential was reached.
 */
export function dedupeCapabilityEntries(
	entries: ReadonlyArray<CapabilitySetEntry>,
): Array<CapabilitySetEntry> {
	const byKey = new Map<string, CapabilitySetEntry>()
	for (const entry of entries) {
		const key = canonicalKey(toCanonicalEntry(entry))
		const existing = byKey.get(key)
		if (!existing || entry.via.length > existing.via.length) {
			byKey.set(key, {
				...entry,
				hosts: sortHosts(entry.hosts),
			})
		}
	}
	return Array.from(byKey.values()).sort((left, right) =>
		canonicalKey(toCanonicalEntry(left)).localeCompare(
			canonicalKey(toCanonicalEntry(right)),
		),
	)
}

export async function fingerprintCapabilityEntries(
	entries: ReadonlyArray<CapabilitySetEntry>,
): Promise<string> {
	const canonical = dedupeCapabilityEntries(entries).map(toCanonicalEntry)
	return sha256Hex(JSON.stringify(canonical))
}

export async function buildCapabilitySet(
	entries: ReadonlyArray<CapabilitySetEntry>,
): Promise<CapabilitySet> {
	const deduped = dedupeCapabilityEntries(entries)
	return {
		entries: deduped,
		fingerprint: await fingerprintCapabilityEntries(deduped),
	}
}

export function capabilitySetsEqual(
	leftFingerprint: string,
	rightFingerprint: string,
) {
	return leftFingerprint === rightFingerprint
}
