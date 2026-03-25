import { insertMcpSkill, listMcpSkillsByUserId } from './mcp-skills-repo.ts'
import { prepareSkillPersistence } from './skill-mutation.ts'
import { upsertSkillVector } from './skill-vectorize.ts'

type BuiltinSkillTemplate = {
	templateKey: string
	title: string
	description: string
	keywords: Array<string>
	code: string
	searchText: string
	usesCapabilities: Array<string>
	connectionBindings: Array<{
		provider: string
		selection: { strategy: 'default' }
		description: string
		required: true
	}>
	parameters?: Array<{
		name: string
		type: 'string' | 'number' | 'boolean' | 'json'
		description: string
		required?: boolean
		defaultValue?: unknown
	}>
	readOnly: boolean
	idempotent: boolean
	destructive: boolean
}

const builtinSkillTemplates: Array<BuiltinSkillTemplate> = [
	{
		templateKey: 'builtin:github-rest-request',
		title: 'GitHub REST Request',
		description:
			'Run a low-level GitHub REST request through the user\'s default GitHub connection. If no connection exists yet, the skill can begin a GitHub token setup flow instead.',
		keywords: ['github', 'rest', 'api', 'request', 'raw', 'connection'],
		searchText:
			'GitHub REST raw request connection backed default GitHub PAT setup flow',
		usesCapabilities: ['connections_begin_setup', 'connections_resolve', 'provider_http_request'],
		connectionBindings: [
			{
				provider: 'github',
				selection: { strategy: 'default' },
				description: 'Uses the default GitHub connection.',
				required: true,
			},
		],
		parameters: [
			{
				name: 'method',
				type: 'string',
				description: 'HTTP method like GET, POST, PUT, PATCH, or DELETE.',
				required: true,
			},
			{
				name: 'path',
				type: 'string',
				description:
					'GitHub REST path beginning with /, such as /repos/kentcdodds/kody/pulls.',
				required: true,
			},
			{
				name: 'query',
				type: 'json',
				description: 'Optional query string parameters.',
			},
			{
				name: 'body',
				type: 'json',
				description: 'Optional JSON body for write operations.',
			},
		],
		readOnly: false,
		idempotent: false,
		destructive: true,
		code: `async (params) => {
  const connection = await codemode.connections_resolve({
    provider: 'github',
    selection: { strategy: 'default' },
    allow_missing: true,
  })

  if (!connection.found) {
    const setup = await codemode.connections_begin_setup({
      provider: {
        key: 'github',
        display_name: 'GitHub',
      },
      auth: {
        strategy: 'manual_token',
        instructions: [
          'Create a GitHub personal access token in your GitHub settings.',
          'Grant the scopes required for this workflow, then submit it through the secure input UI.',
        ],
        secret_fields: [
          {
            name: 'personal_access_token',
            label: 'Personal Access Token',
            input_type: 'password',
          },
        ],
        request: {
          base_url: 'https://api.github.com',
          default_headers: {
            accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
          },
          auth_transport: {
            type: 'bearer_header',
            secret_field: 'personal_access_token',
          },
          graphql_path: '/graphql',
        },
        verification: {
          method: 'GET',
          path: '/user',
        },
      },
      label: 'github',
    })

    return {
      ok: false,
      next_action: 'connect_account',
      provider: 'github',
      setup_id: setup.setup_id,
      message: 'Create a GitHub connection, submit the PAT securely, finalize the connection, then run this skill again.',
      secret_fields: setup.secret_fields,
    }
  }

  return await codemode.provider_http_request({
    connection_handle: connection.handle,
    request: {
      method: params.method,
      path: params.path,
      ...(params.query ? { query: params.query } : {}),
      ...(params.body !== undefined ? { body: params.body } : {}),
    },
  })
}`,
	},
	{
		templateKey: 'builtin:github-graphql-request',
		title: 'GitHub GraphQL Request',
		description:
			'Run a GitHub GraphQL query or mutation through the user\'s default GitHub connection.',
		keywords: ['github', 'graphql', 'query', 'mutation', 'connection'],
		searchText:
			'GitHub GraphQL connection backed request default GitHub PAT setup flow',
		usesCapabilities: ['connections_resolve', 'provider_graphql_request'],
		connectionBindings: [
			{
				provider: 'github',
				selection: { strategy: 'default' },
				description: 'Uses the default GitHub connection.',
				required: true,
			},
		],
		parameters: [
			{
				name: 'query',
				type: 'string',
				description: 'GraphQL query or mutation string.',
				required: true,
			},
			{
				name: 'variables',
				type: 'json',
				description: 'Optional GraphQL variables object.',
			},
			{
				name: 'operationName',
				type: 'string',
				description: 'Optional GraphQL operation name.',
			},
		],
		readOnly: false,
		idempotent: false,
		destructive: true,
		code: `async (params) => {
  const connection = await codemode.connections_resolve({
    provider: 'github',
    selection: { strategy: 'default' },
  })

  return await codemode.provider_graphql_request({
    connection_handle: connection.handle,
    query: params.query,
    ...(params.variables ? { variables: params.variables } : {}),
    ...(params.operationName ? { operationName: params.operationName } : {}),
  })
}`,
	},
	{
		templateKey: 'builtin:cloudflare-rest-request',
		title: 'Cloudflare API Request',
		description:
			'Run a low-level Cloudflare API request through the user\'s default Cloudflare connection.',
		keywords: ['cloudflare', 'api', 'rest', 'request', 'dns', 'workers'],
		searchText:
			'Cloudflare API request connection backed default API token worker dns zones',
		usesCapabilities: ['connections_resolve', 'provider_http_request'],
		connectionBindings: [
			{
				provider: 'cloudflare',
				selection: { strategy: 'default' },
				description: 'Uses the default Cloudflare connection.',
				required: true,
			},
		],
		parameters: [
			{
				name: 'method',
				type: 'string',
				description: 'HTTP method like GET, POST, PUT, PATCH, or DELETE.',
				required: true,
			},
			{
				name: 'path',
				type: 'string',
				description:
					'Cloudflare API path beginning with /client/v4/, such as /client/v4/accounts.',
				required: true,
			},
			{
				name: 'query',
				type: 'json',
				description: 'Optional query string parameters.',
			},
			{
				name: 'body',
				type: 'json',
				description: 'Optional JSON body for write operations.',
			},
		],
		readOnly: false,
		idempotent: false,
		destructive: true,
		code: `async (params) => {
  const connection = await codemode.connections_resolve({
    provider: 'cloudflare',
    selection: { strategy: 'default' },
  })

  return await codemode.provider_http_request({
    connection_handle: connection.handle,
    request: {
      method: params.method,
      path: params.path,
      ...(params.query ? { query: params.query } : {}),
      ...(params.body !== undefined ? { body: params.body } : {}),
    },
  })
}`,
	},
	{
		templateKey: 'builtin:cursor-cloud-rest-request',
		title: 'Cursor Cloud Request',
		description:
			'Run a low-level Cursor Cloud API request through the user\'s default Cursor connection.',
		keywords: ['cursor', 'cloud', 'agent', 'api', 'request'],
		searchText:
			'Cursor Cloud request connection backed default API key agents launch stop',
		usesCapabilities: ['connections_resolve', 'provider_http_request'],
		connectionBindings: [
			{
				provider: 'cursor',
				selection: { strategy: 'default' },
				description: 'Uses the default Cursor connection.',
				required: true,
			},
		],
		parameters: [
			{
				name: 'method',
				type: 'string',
				description: 'HTTP method like GET, POST, PUT, PATCH, or DELETE.',
				required: true,
			},
			{
				name: 'path',
				type: 'string',
				description: 'Cursor Cloud API path beginning with /v0/.',
				required: true,
			},
			{
				name: 'query',
				type: 'json',
				description: 'Optional query string parameters.',
			},
			{
				name: 'body',
				type: 'json',
				description: 'Optional JSON body for write operations.',
			},
		],
		readOnly: false,
		idempotent: false,
		destructive: true,
		code: `async (params) => {
  const connection = await codemode.connections_resolve({
    provider: 'cursor',
    selection: { strategy: 'default' },
  })

  return await codemode.provider_http_request({
    connection_handle: connection.handle,
    request: {
      method: params.method,
      path: params.path,
      ...(params.query ? { query: params.query } : {}),
      ...(params.body !== undefined ? { body: params.body } : {}),
    },
  })
}`,
	},
]

export async function ensureBuiltinSkillTemplatesForUser(
	env: Env,
	userId: string,
) {
	let skillRows = await listMcpSkillsByUserId(env.APP_DB, userId)
	const existingTemplateKeys = new Set(
		skillRows
			.map((skill) => skill.template_key)
			.filter((templateKey): templateKey is string => typeof templateKey === 'string'),
	)
	const missingTemplates = builtinSkillTemplates.filter(
		(template) => !existingTemplateKeys.has(template.templateKey),
	)
	if (missingTemplates.length === 0) {
		return skillRows
	}

	for (const template of missingTemplates) {
		const prep = await prepareSkillPersistence({
			title: template.title,
			description: template.description,
			keywords: template.keywords,
			code: template.code,
			search_text: template.searchText,
			uses_capabilities: template.usesCapabilities,
			parameters: template.parameters,
			connection_bindings: template.connectionBindings,
			template_key: template.templateKey,
			read_only: template.readOnly,
			idempotent: template.idempotent,
			destructive: template.destructive,
		})
		const skillId = crypto.randomUUID()
		await insertMcpSkill(env.APP_DB, {
			id: skillId,
			user_id: userId,
			...prep.rowPayload,
		})
		await upsertSkillVector(env, {
			skillId,
			userId,
			embedText: prep.embedText,
		})
	}

	skillRows = await listMcpSkillsByUserId(env.APP_DB, userId)
	return skillRows
}
