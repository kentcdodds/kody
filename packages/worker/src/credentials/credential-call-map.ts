/**
 * A call map (ADR 0068 "Call shapes"): the caller's exact picks for a run's
 * credential needs, by need key.
 *
 * ```
 * credentials: { github: 'work', google: ['work', 'personal'], x: { name: 'work', scope: 'org' } }
 * ```
 *
 * A string is a credential name; an object adds a scope; an array picks
 * several for a `credentials(key)` call, and `[]` picks none on purpose. A
 * pick grants nothing: it only chooses among credentials the actor can Use.
 */
import { z } from 'zod'

export const credentialCallMapLimits = {
	maxKeys: 32,
	maxPicksPerKey: 16,
	maxTextLength: 100,
} as const

const text = z.string().trim().min(1).max(credentialCallMapLimits.maxTextLength)

// A need key or a provider slug, untrimmed so no two keys collapse into one.
const keyPattern = new RegExp(
	`^[A-Za-z0-9][A-Za-z0-9._-]{0,${credentialCallMapLimits.maxTextLength - 1}}$`,
)

const credentialCallMapKey = z
	.string()
	.regex(
		keyPattern,
		'A credentials map key starts with a letter or digit and uses letters, digits, dots, underscores, or hyphens.',
	)

const credentialPickSchema = z.union([
	text,
	z
		.object({
			name: text,
			scope: z.enum(['org', 'personal']).optional(),
		})
		.strict(),
])

export const credentialCallMapSchema = z
	.record(
		credentialCallMapKey,
		z.union([
			credentialPickSchema,
			z.array(credentialPickSchema).max(credentialCallMapLimits.maxPicksPerKey),
		]),
	)
	.refine(
		(map) => Object.keys(map).length <= credentialCallMapLimits.maxKeys,
		`A credentials map takes at most ${credentialCallMapLimits.maxKeys} keys.`,
	)
	.describe(
		'Optional credential picks by need key, for `credential(key)` / `credentials(key)` in this run: `{ github: "work", google: ["work", "personal"], x: { name: "work", scope: "org" } }`. A string is a credential name; add `scope` ("org" or "personal") when an org and a personal credential share the name; an array picks several for `credentials(key)`, and `[]` picks none. Picks choose only among credentials you can Use.',
	)

export type CredentialCallMapInput = z.infer<typeof credentialCallMapSchema>

export type CredentialPick = {
	name: string
	scope: 'org' | 'personal' | null
}

export type CredentialCallMap = ReadonlyMap<
	string,
	ReadonlyArray<CredentialPick>
>

/** A call map for one run, validated before its code runs. */
export type RunCredentialCallMap = {
	map: CredentialCallMap
	/** An unknown key is an error (an invoke) rather than a warning. */
	strict: boolean
	onWarnings?: (warnings: Array<string>) => void
	/**
	 * Already checked by the run that started this one (a computed `import()`
	 * library load): only the credential tools use it.
	 */
	checked?: boolean
}

export function normalizeCredentialCallMap(
	input: CredentialCallMapInput | null | undefined,
): CredentialCallMap | null {
	if (!input) return null
	const map = new Map<string, ReadonlyArray<CredentialPick>>()
	for (const [key, value] of Object.entries(input)) {
		const picks = (Array.isArray(value) ? value : [value]).map((pick) =>
			typeof pick === 'string'
				? { name: pick, scope: null }
				: { name: pick.name, scope: pick.scope ?? null },
		)
		map.set(key, picks)
	}
	return map.size > 0 ? map : null
}
