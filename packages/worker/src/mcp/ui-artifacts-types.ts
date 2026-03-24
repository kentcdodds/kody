export type UiArtifactRuntime = 'javascript'

export type UiArtifactRow = {
	id: string
	user_id: string
	title: string
	description: string
	keywords: string
	code: string
	runtime: UiArtifactRuntime
	search_text: string | null
	created_at: string
	updated_at: string
}
