export type UiArtifactRow = {
	id: string
	user_id: string
	title: string
	description: string
	sourceId: string | null
	hasServerCode: boolean
	parameters: string | null
	hidden: boolean
	created_at: string
	updated_at: string
}

export function hasUiArtifactServerCode(
	hasServerCode: boolean | null | undefined,
): hasServerCode is true {
	return hasServerCode === true
}
