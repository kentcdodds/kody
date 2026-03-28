import { z } from 'zod'
import { defineDomainCapability } from '../define-domain-capability.ts'
import { capabilityDomainNames } from '../domain-metadata.ts'
import { type CapabilityContext } from '../types.ts'

const inputSchema = z
	.object({})
	.describe(
		'No input. Returns the Kody guide for using the /connect/secret page to collect API keys and personal access tokens.',
	)

const outputSchema = z.object({
	title: z.string().describe('Guide title.'),
	body: z.string().describe('Markdown guidance for /connect/secret usage.'),
})

const guideBody = `
# Connect secret guide

Use the hosted **/connect/secret** page whenever the user needs to enter a
secret value such as an API key or personal access token. The agent must never
see the secret value.

## When to use /connect/secret

Use it when:

- you need the user to provide a sensitive value
- a capability requires a secret placeholder that is missing
- rotating a stored secret value

Do **not** ask the user to paste secrets into chat.

## URL format

Provide the user a URL like:

\`\`\`
https://heykody.dev/connect/secret?
  name=linearApiKey
  &description=Linear API key for issue management
  &allowedHosts=api.linear.app
  &scope=user
  &dashboardUrl=https://linear.app/settings/api
  &instructions=Go to Linear Settings → API → Personal API Keys → Create key
  &allowedCapabilities=linear_issue_list,linear_issue_create
  &connector=linear
\`\`\`

## Query params

| Param | Required | Description |
| --- | --- | --- |
| \`name\` | yes | Secret name (e.g. \`linearApiKey\`). |
| \`description\` | no | Human-readable description shown in the UI. |
| \`allowedHosts\` | no | Comma-separated hosts to review for approval. |
| \`allowedCapabilities\` | no | Comma-separated capability names to review. Use only real Kody capability names (discoverable via search or meta_list_capabilities). |
| \`scope\` | no | \`user\` (default), \`session\`, or \`app\`. |
| \`appId\` | no | Required when \`scope=app\`. Use the saved UI app's real \`app_id\`. |
| \`dashboardUrl\` | no | Provider settings link for creating the key. |
| \`instructions\` | no | Step-by-step instructions shown on the page. |
| \`connector\` | no | Writes \`_connector:{connector}\` config on save. |

## Approval policy reminders

- Saving a secret does **not** approve outbound hosts.
- The connect page only shows the requested hosts/capabilities for review.
- Host and capability approvals must be handled in the authenticated account
  secrets UI after the secret is saved.

## Agent instructions

1. Generate the URL with the required \`name\` and any optional params.
   - When using \`scope=app\`, you must also include the saved app's real
     \`appId\`.
   - Only include \`allowedCapabilities\` when you have confirmed the capability
     names exist in Kody (use \`search\` or \`meta_list_capabilities\`).
2. Ask the user to open the URL in their browser.
3. Wait until they confirm the secret is saved.
4. Proceed using \`{{secret:name}}\` placeholders or the relevant capability.
`.trim()

export const generatedUiSecretGuideCapability = defineDomainCapability(
	capabilityDomainNames.coding,
	{
		name: 'generated_ui_secret_guide',
		description:
			'Read the guide for using the hosted /connect/secret page to collect API keys and personal access tokens safely.',
		keywords: [
			'secret',
			'api key',
			'personal access token',
			'connect secret',
			'generated ui',
			'hosted page',
			'credentials',
		],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema,
		outputSchema,
		async handler(_args, _ctx: CapabilityContext) {
			return {
				title: 'Connect secret guide',
				body: guideBody,
			}
		},
	},
)
