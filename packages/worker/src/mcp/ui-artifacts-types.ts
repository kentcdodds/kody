export type UiArtifactRow = {
	id: string
	user_id: string
	title: string
	description: string
	sourceId: string | null
	hasClient: boolean
	hasServerCode: boolean
	parameters: string | null
	hidden: boolean
	taskNames: Array<string>
	jobNames: Array<string>
	scheduleSummaries: Array<string>
	created_at: string
	updated_at: string
}

export function hasUiArtifactServerCode(
	hasServerCode: boolean | null | undefined,
): hasServerCode is true {
	return hasServerCode === true
}
