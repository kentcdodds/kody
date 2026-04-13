export type UiArtifactRow = {
	id: string
	user_id: string
	title: string
	description: string
	clientCode: string
	serverCode: string | null
	serverCodeId: string
	parameters: string | null
	hidden: boolean
	created_at: string
	updated_at: string
}
