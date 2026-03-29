export type UiArtifactRuntime = 'html' | 'javascript'

export type UiArtifactRow = {
	id: string
	user_id: string
	title: string
	description: string
	code: string
	runtime: UiArtifactRuntime
	parameters: string | null
	created_at: string
	updated_at: string
}
