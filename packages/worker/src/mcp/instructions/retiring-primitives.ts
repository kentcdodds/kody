/**
 * Always-on MCP notices for primitives in active retirement.
 *
 * Keep each notice one line. Put the destination map and migration steps in
 * a `coding_guide_get` guide — server instructions stay compact
 * (`docs/contributing/documentation.md`). When the last notice is removed,
 * `formatRetiringPrimitivesInstructions` returns empty and the section is
 * omitted from the assembled server instructions.
 */

export type RetiringPrimitiveNotice = {
	/** Human label (for example "Values"). */
	label: string
	/** `coding_guide_get` id that holds the destination map and steps. */
	guide: string
	/** Present-tense rule. Do not narrate the rollout. */
	summary: string
}

export const retiringPrimitiveNotices = [
	{
		label: 'Values',
		guide: 'values',
		summary:
			'Do not write new `value_set` rows. Existing names stay readable.',
	},
] as const satisfies ReadonlyArray<RetiringPrimitiveNotice>

export function formatRetiringPrimitivesInstructions(
	notices: ReadonlyArray<RetiringPrimitiveNotice> = retiringPrimitiveNotices,
): string {
	if (notices.length === 0) return ''
	const bullets = notices.map(
		(notice) =>
			`- ${notice.label}: ${notice.summary} Load \`coding_guide_get({ guide: "${notice.guide}" })\` to migrate.`,
	)
	return `Retiring primitives
${bullets.join('\n')}`
}
