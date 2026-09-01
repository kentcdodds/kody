/**
 * Per-affected-user MCP notices for primitives in active retirement.
 *
 * Keep each notice one line. Put the destination map and migration steps in
 * a `{id}:guide` search entity — server instructions stay compact
 * (`docs/contributing/documentation.md`). Assembly includes a notice only when
 * that user still has rows of the retiring primitive. When the last notice is
 * removed, `formatRetiringPrimitivesInstructions` returns empty and the
 * section is omitted from the assembled server instructions.
 */

export type RetiringPrimitiveNotice = {
	/** Stable id used to gate the notice per affected user. */
	id: string
	/** Human label (for example "Jobs"). */
	label: string
	/** Official guide id that holds the destination map and steps. */
	guide: string
	/** Present-tense rule. Do not narrate the rollout. */
	summary: string
}

export const retiringPrimitiveNotices: ReadonlyArray<RetiringPrimitiveNotice> =
	[]

export type RetiringPrimitiveNoticeId = string

export async function loadActiveRetiringNoticeIds(
	_db: D1Database,
	_userId: string | null,
): Promise<ReadonlySet<RetiringPrimitiveNoticeId>> {
	return new Set()
}

export function formatRetiringPrimitivesInstructions(
	notices: ReadonlyArray<
		Pick<RetiringPrimitiveNotice, 'label' | 'guide' | 'summary'>
	> = [],
): string {
	if (notices.length === 0) return ''
	const bullets = notices.map(
		(notice) =>
			`- ${notice.label}: ${notice.summary} Load \`search({ entity: "${notice.guide}:guide" })\` to migrate.`,
	)
	return `Retiring primitives
${bullets.join('\n')}`
}

export function formatActiveRetiringPrimitivesInstructions(
	activeIds: ReadonlySet<RetiringPrimitiveNoticeId>,
): string {
	return formatRetiringPrimitivesInstructions(
		retiringPrimitiveNotices.filter((notice) => activeIds.has(notice.id)),
	)
}
