import { registerAppTool } from '@modelcontextprotocol/ext-apps/server'
import { type ToolAnnotations } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { generatedUiShellResourceUri } from '#mcp/apps/generated-ui-shell-entry-point.ts'
import { createGeneratedUiAppSession } from '#mcp/generated-ui-app-session.ts'
import { type McpRegistrationAgent } from '#mcp/mcp-registration-agent.ts'
import {
	applyUiArtifactParameters,
	parseUiArtifactParameters,
} from '#mcp/ui-artifact-parameters.ts'
import { getUiArtifactById } from '#mcp/ui-artifacts-repo.ts'
import { buildSavedUiUrl } from '#worker/ui-artifact-urls.ts'

const openGeneratedUiTool = {
	name: 'open_generated_ui',
	title: 'Open Generated UI',
	description: `
Open the generic MCP App shell for a generated UI.

Behavior:
- Accepts exactly one of \`code\` or \`app_id\`.
- Use \`code\` to render a new UI artifact immediately without saving it first.
- Use \`app_id\` to reopen previously saved UI source without sending that source code back through the model.
- Saved apps can declare reusable parameters; pass runtime values via \`params\` and read the resolved values from \`window.kodyWidget.params\` inside the app.
- \`code\` may be a full HTML document or a fragment. Prefer body content when possible, but full-document HTML is supported when you need total control.
- The shell provides a tiny standard library on \`window.kodyWidget\` plus lightweight default styles for semantic HTML, forms, tables, buttons, and code blocks.
- After rendering, the shell automatically reports the rendered widget size to the host via the standard MCP Apps \`ui/notifications/size-changed\` notification.
- \`executeCode(code)\` runs server-side code through the generated UI session when available, keeping secret resolution on the server.
- \`saveSecret({ name, value, description?, scope? })\`, \`saveSecrets([...])\`, \`listSecrets({ scope? })\`, and \`deleteSecret({ name, scope? })\` let the UI manage secret references without embedding raw values in generated code.
- Use generated UI whenever the user needs to enter a sensitive value. Do not ask the user to paste secrets, tokens, API keys, passwords, OAuth codes, or other credentials into chat.
- Saving a secret does not authorize outbound use automatically. If generated code later needs to send that secret to a host, the agent must ask the user to approve that host through the app approval flow.
- Secret metadata returned by the UI helpers includes \`allowed_hosts\`, \`created_at\`, \`updated_at\`, and \`ttl_ms\` when available so the UI can explain lifecycle, approval state, and expiry.
- Prefer the higher-level helpers below for OAuth, form persistence, and secret-bearing requests instead of hand-rolling state handling or parsing raw approval-link errors.
- If an OAuth flow needs a callback URL, do not rely on an ephemeral inline render. Persist the UI with \`ui_save_app\`, reopen it as a hosted saved app, and use that hosted URL as the provider callback/redirect target so the generated UI can receive and handle the callback on reload.
- When the OAuth provider does not support dynamic client registration, the agent should tell the user the exact registration values to enter in the provider's app settings instead of vaguely saying "set up OAuth." At minimum, provide the exact callback/redirect URL, and include any other required values such as homepage URL, origin, or logout URL when that provider requires them.

Mini standard library:
\`\`\`ts
type SecretScope = 'session' | 'app' | 'user'

type SecretMetadata = {
  name: string
  scope: SecretScope
  description: string
  app_id: string | null
  allowed_hosts: string[]
  created_at: string
  updated_at: string
  ttl_ms: number | null
}

type SaveSecretInput = {
  name: string
  value: string
  description?: string
  scope?: SecretScope
}

type SaveSecretResult = {
  ok: boolean
  secret?: SecretMetadata
  error?: string
}

type SaveSecretsResult = {
  ok: boolean
  results: Array<{
    name: string
    ok: boolean
    secret?: SecretMetadata
    error?: string
  }>
}

type FetchWithSecretsSuccess = {
  ok: true
  status: number
  headers: Record<string, string>
  data: unknown
  text: string | null
}

type FetchWithSecretsHttpError = {
  ok: false
  kind: 'http_error'
  status: number
  headers: Record<string, string>
  data: unknown
  text: string | null
}

type FetchWithSecretsApprovalError = {
  ok: false
  kind: 'host_approval_required'
  approvalUrl: string | null
  message: string
  host: string | null
  secretNames: string[]
}

type FetchWithSecretsExecutionError = {
  ok: false
  kind: 'execution_error'
  message: string
}

type FetchWithSecretsResult =
  | FetchWithSecretsSuccess
  | FetchWithSecretsHttpError
  | FetchWithSecretsApprovalError
  | FetchWithSecretsExecutionError

type OAuthCallbackResult =
  | { kind: 'none' }
  | {
      kind: 'error'
      error: string
      errorDescription: string | null
      callbackUrl: string
    }
  | {
      kind: 'success'
      code: string
      state: string | null
      callbackUrl: string
      expectedState: string | null
      stateMatches: boolean | null
    }

type SecretFormController = {
  form: HTMLFormElement
  save(): Promise<SaveSecretsResult>
  destroy(): void
}

declare global {
  interface Window {
    kodyWidget: {
      params: Record<string, unknown>
      sendMessage(text: string): boolean
      openLink(url: string): boolean
      toggleFullscreen(): Promise<'inline' | 'fullscreen' | 'pip' | null>
      executeCode(code: string): Promise<unknown>
      saveSecret(input: SaveSecretInput): Promise<SaveSecretResult>
      saveSecrets(input: SaveSecretInput[]): Promise<SaveSecretsResult>
      listSecrets(input?: { scope?: SecretScope }): Promise<SecretMetadata[]>
      deleteSecret(input: { name: string; scope?: SecretScope }): Promise<{ ok: boolean; deleted?: boolean; error?: string }>

      formToObject(form: HTMLFormElement | string): Record<string, FormDataEntryValue | FormDataEntryValue[]>
      fillFromSearchParams(form: HTMLFormElement | string, mapping?: Record<string, string>): Record<string, FormDataEntryValue | FormDataEntryValue[]>
      persistForm(form: HTMLFormElement | string, options: { storageKey: string; fields?: string[] }): Record<string, string | string[]>
      restoreForm(form: HTMLFormElement | string, options: { storageKey: string }): Record<string, FormDataEntryValue | FormDataEntryValue[]> | null

      buildSecretForm(input: {
        form: HTMLFormElement | string
        fields: Array<{
          inputName: string
          secretName: string
          description?: string
          scope?: SecretScope
        }>
        onSuccess?: (
          result: SaveSecretsResult,
          values: Record<string, FormDataEntryValue | FormDataEntryValue[]>
        ) => void | Promise<void>
        onError?: (
          result: SaveSecretsResult,
          values: Record<string, FormDataEntryValue | FormDataEntryValue[]>
        ) => void | Promise<void>
      }): SecretFormController

      createOAuthState(key: string): string
      getOAuthState(key: string): string | null
      clearOAuthState(key: string): void
      validateOAuthCallbackState(input: {
        key: string
        returnedState: string | null | undefined
      }): {
        valid: boolean
        expectedState: string | null
        returnedState: string | null
      }
      readOAuthCallback(input?: {
        url?: string
        expectedStateKey?: string
      }): OAuthCallbackResult

      fetchWithSecrets(input: {
        url: string
        method?: string
        headers?: Record<string, string>
        body?: string | Record<string, unknown> | unknown[] | null
      }): Promise<FetchWithSecretsResult>
      exchangeOAuthCode(input: {
        tokenUrl: string
        code: string
        redirectUri: string
        clientIdSecretName: string
        clientSecretSecretName: string
        scope?: SecretScope
        extraParams?: Record<string, string | number | boolean>
      }): Promise<FetchWithSecretsResult>
      saveOAuthTokens(input: {
        payload: Record<string, unknown>
        accessTokenSecretName: string
        refreshTokenSecretName?: string
        scope?: SecretScope
        accessTokenDescription?: string
        refreshTokenDescription?: string
      }): Promise<{
        ok: boolean
        accessTokenSaved: boolean
        refreshTokenSaved: boolean
        error?: string
        results: SaveSecretsResult['results']
      }>
    }
  }
}
\`\`\`

How to use the helpers:
- Use \`saveSecrets([...])\` when a form collects multiple credentials such as client ID + client secret.
- Use \`buildSecretForm(...)\` when a normal HTML form should save one or more fields as secrets on submit.
- \`formToObject(...)\` returns one value per field name by default. If the same field name appears multiple times, it returns an array from \`FormData.getAll(...)\` for that key instead of dropping repeated values.
- Use \`createOAuthState(...)\`, \`readOAuthCallback(...)\`, and \`validateOAuthCallbackState(...)\` for hosted OAuth pages instead of hand-rolling state storage and callback parsing.
- If the OAuth flow requires a browser callback, save the UI first and use the hosted saved-app URL as the callback target. Inline ephemeral UIs are not sufficient for provider callbacks that must return to a stable URL.
- Use \`exchangeOAuthCode(...)\` for OAuth token exchanges that should run through server-side \`execute\` with secret placeholders.
- Use \`saveOAuthTokens(...)\` right after a successful token exchange to persist \`access_token\` and optional \`refresh_token\` under explicit secret names.
- Use \`fetchWithSecrets(...)\` when the UI needs to make a secret-bearing outbound request and handle approval-required failures in a structured way. If it returns \`kind: 'host_approval_required'\`, show the approval link and retry only after the user approves it in the account admin UI.

Theme tokens:
- \`--color-bg\`, \`--color-surface\`, \`--color-fg\`, \`--color-muted\`
- \`--color-border\`, \`--color-accent\`, \`--color-accent-contrast\`
- \`--font-body\`, \`--font-mono\`
- \`--spacing-2\`, \`--spacing-3\`, \`--spacing-4\`, \`--spacing-6\`
- \`--radius-2\`, \`--radius-3\`, \`--shadow-1\`

Example:
\`\`\`html
<form>
  ...
</form>
<script>
  document.querySelector('form')?.addEventListener('submit', async (event) => {
    event.preventDefault()
    const saveResult = await window.kodyWidget.saveSecrets([
      {
        name: 'github-oauth-client-id',
        value: '...',
        description: 'GitHub OAuth client ID',
        scope: 'user',
      },
      {
        name: 'github-oauth-client-secret',
        value: '...',
        description: 'GitHub OAuth client secret',
        scope: 'user',
      },
    ])
    if (!saveResult.ok) return

    const state = window.kodyWidget.createOAuthState('github-oauth')
    const tokenResult = await window.kodyWidget.exchangeOAuthCode({
      tokenUrl: 'https://github.com/login/oauth/access_token',
      code: '...',
      redirectUri: 'https://example.com/callback',
      clientIdSecretName: 'github-oauth-client-id',
      clientSecretSecretName: 'github-oauth-client-secret',
      scope: 'user',
    })
    if (tokenResult.ok) {
      await window.kodyWidget.saveOAuthTokens({
        payload: tokenResult.data as Record<string, unknown>,
        accessTokenSecretName: 'github-access-token',
        refreshTokenSecretName: 'github-refresh-token',
        scope: 'user',
      })
    }
  })
</script>
\`\`\`

Use this tool when:
- You have already generated the UI source and want to render it.
- You found a saved app via \`search\` and want to reopen it by id.

Next:
- Use \`ui_save_app\` to persist a reusable UI artifact.
- Use \`ui_get_app\` when you need to inspect a saved artifact's metadata or source.
- Use \`ui_list_apps\` or \`search\` to discover saved apps.
	`.trim(),
	annotations: {
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: false,
	} satisfies ToolAnnotations,
} as const

const inputSchema = z
	.object({
		code: z
			.string()
			.min(1)
			.optional()
			.describe('Inline UI source to render immediately.'),
		app_id: z
			.string()
			.min(1)
			.optional()
			.describe('Saved UI artifact id to reopen.'),
		title: z
			.string()
			.min(1)
			.optional()
			.describe('Optional display title for the current render session.'),
		description: z
			.string()
			.min(1)
			.optional()
			.describe('Optional short description for the current render session.'),
		params: z
			.record(z.string(), z.unknown())
			.optional()
			.describe(
				'Optional runtime parameter values for a saved app (validated against its saved parameter definitions).',
			),
	})
	.refine((value) => (value.code ? 1 : 0) + (value.app_id ? 1 : 0) === 1, {
		message: 'Provide exactly one of `code` or `app_id`.',
		path: ['code'],
	})
	.refine((value) => !(value.code && value.params), {
		message: '`params` is only supported with `app_id`.',
		path: ['params'],
	})

export async function registerOpenGeneratedUiTool(agent: McpRegistrationAgent) {
	registerAppTool(
		agent.server,
		openGeneratedUiTool.name,
		{
			title: openGeneratedUiTool.title,
			description: openGeneratedUiTool.description,
			inputSchema,
			annotations: openGeneratedUiTool.annotations,
			_meta: {
				ui: {
					resourceUri: generatedUiShellResourceUri,
				},
			},
		},
		async (args) => {
			const callerContext = agent.getCallerContext()
			const appId = args.app_id ?? null
			const title = args.title ?? null
			const description = args.description ?? null
			let resolvedParams: Record<string, unknown> | undefined
			if (appId) {
				if (!callerContext.user) {
					throw new Error(
						'Authentication required to access saved UI artifacts.',
					)
				}
				const app = await getUiArtifactById(
					agent.getEnv().APP_DB,
					callerContext.user.userId,
					appId,
				)
				if (!app) {
					throw new Error('Saved UI artifact not found for this user.')
				}
				resolvedParams = applyUiArtifactParameters({
					definitions: parseUiArtifactParameters(app.parameters),
					values: args.params,
				})
			}
			const hostedUrl = appId
				? buildSavedUiUrl(agent.requireDomain(), appId, {
						params: resolvedParams,
					})
				: null
			const appSession =
				callerContext.user != null
					? await createGeneratedUiAppSession({
							env: agent.getEnv(),
							baseUrl: callerContext.baseUrl,
							user: callerContext.user,
							appId,
							homeConnectorId: callerContext.homeConnectorId ?? null,
							params: resolvedParams,
						})
					: null
			const structuredContent = {
				widget: 'generated_ui' as const,
				resourceUri: generatedUiShellResourceUri,
				renderSource: appId ? ('saved_app' as const) : ('inline_code' as const),
				appId,
				title,
				description,
				runtime: 'html' as const,
				sourceCode: args.code ?? null,
				params: resolvedParams,
				hostedUrl,
				appSession,
			}
			return {
				content: [
					{
						type: 'text',
						text: appId
							? `## Generated UI ready\n\nThe generic app shell is attached to this tool call and will load saved app \`${appId}\` inside the widget runtime.\n\nIf the host does not display the attached UI correctly, open the hosted fallback URL: ${hostedUrl}`
							: '## Generated UI ready\n\nThe generic app shell is attached to this tool call and will render the provided inline source inside the widget runtime.',
					},
				],
				structuredContent,
			}
		},
	)
}
