export const acquisitionPageMeta = {
	useCases: {
		key: 'useCases',
		path: '/use-cases',
		title: 'What will you build with Kody?',
		description:
			'Build reusable tools, automate inbox work, share context across your agents, and run workflows on a schedule with Kody.',
	},
	n8nAlternatives: {
		key: 'n8nAlternatives',
		path: '/compare/n8n-alternatives',
		title: 'n8n alternatives for developers',
		description:
			'Build reusable workflows with your agent in Kody. Compare its packages, connected accounts, and schedules with n8n and other automation tools.',
	},
	mcpGateway: {
		key: 'mcpGateway',
		path: '/use-cases/mcp-gateway',
		title: 'An MCP gateway for your personal agents',
		description:
			'Understand direct MCP connections, gateways, and Kody. Connect agents to shared tools, accounts, memory, and saved workflows.',
	},
	sharedMemory: {
		key: 'sharedMemory',
		path: '/use-cases/shared-agent-memory',
		title: 'Shared memory for Claude Code, Cursor, and Codex',
		description:
			'Save your preferences and project context in Kody so Claude Code, Cursor, and Codex can find and use the same memories.',
	},
	gmail: {
		key: 'gmail',
		path: '/integrations/gmail',
		title: 'Gmail automation with Claude and MCP',
		description:
			'Connect Gmail to your agent and build an inbox workflow you can use again, with drafts to review and control over what gets sent.',
	},
	customTools: {
		key: 'customTools',
		path: '/use-cases/claude-code-custom-tools',
		title: 'Build reusable custom tools for Claude Code',
		description:
			'Turn a repeated Claude Code task into a Kody package. Keep the code and connected accounts ready for your other agents to use.',
	},
	composioAlternatives: {
		key: 'composioAlternatives',
		path: '/compare/composio-alternatives',
		title: 'Composio alternatives for personal agent workflows',
		description:
			'Explore Kody as a Composio alternative for personal agent workflows, with connected accounts, reusable packages, memory, and schedules in one place.',
	},
	slack: {
		key: 'slack',
		path: '/integrations/slack',
		title: 'Slack automation that keeps track of the work',
		description:
			'Build reusable Slack workflows with Kody. Connect your services, keep track of what’s been posted, and review messages before putting them on a schedule.',
	},
	scheduledWorkflows: {
		key: 'scheduledWorkflows',
		path: '/use-cases/scheduled-workflows',
		title: 'Schedule reusable workflows built with Claude',
		description:
			'Run saved code on a schedule with Kody. Automate reports, keep track of progress, and use AI where your workflow needs it.',
	},
	claudeIntegrations: {
		key: 'claudeIntegrations',
		path: '/integrations/claude',
		title: 'Claude integrations you can keep using across agents',
		description:
			'Connect Claude to Kody and reuse your accounts, memory, and tools beyond one conversation. Build workflows you can run from any connected agent.',
	},
	automation: {
		key: 'automation',
		path: '/use-cases/ai-workflow-automation',
		title: 'AI workflow automation for developers',
		description:
			'Choose visual workflows, agent routines, or reusable code. Build automation in Kody with connected accounts, saved packages, memory, and schedules.',
	},
} as const

export const acquisitionPageSummaries = Object.values(acquisitionPageMeta)
