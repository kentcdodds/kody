export type McpSkillRow = {
	id: string
	user_id: string
	title: string
	description: string
	keywords: string
	code: string
	search_text: string | null
	uses_capabilities: string | null
	parameters: string | null
	connection_bindings: string | null
	template_key: string | null
	inferred_capabilities: string
	inference_partial: 0 | 1
	read_only: 0 | 1
	idempotent: 0 | 1
	destructive: 0 | 1
	created_at: string
	updated_at: string
}
