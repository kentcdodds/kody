export const uiArtifactParameterTypes = [
	'string',
	'number',
	'boolean',
	'json',
] as const

export type UiArtifactParameterType = (typeof uiArtifactParameterTypes)[number]

export type UiArtifactParameterInput = {
	name: string
	description: string
	type: UiArtifactParameterType
	required?: boolean | undefined
	default?: unknown
}

export type UiArtifactParameterDefinition = {
	name: string
	description: string
	type: UiArtifactParameterType
	required: boolean
	default?: unknown
}
