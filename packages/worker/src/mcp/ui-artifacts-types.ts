export type UiArtifactRow = {
	id: string
	user_id: string
	title: string
	description: string
	sourceId: string
	parameters: string | null
	hidden: boolean
	hasServerCode?: boolean | null
	created_at: string
	updated_at: string
}

export function hasUiArtifactServerCode(
	serverCode: string | null | undefined,
): serverCode is string {
	return typeof serverCode === 'string' && serverCode.trim().length > 0
}
