import { acquisitionPageMeta } from './metadata.ts'
import { type AcquisitionPage } from './types.ts'

export const sharedMemory = {
	...acquisitionPageMeta.sharedMemory,
	lead: 'Keep the facts you want every agent to know in one Kody account. Claude Code, Cursor, and Codex can use that shared memory when they connect to Kody, while keeping their own local instructions and conversation history.',
	flow: [
		'Save a preference in one agent',
		'Keep it in your Kody account',
		'Retrieve it in another agent',
	],
	sections: [
		{
			title: 'One preference, three agents',
			paragraphs: [
				'For example, save this release-summary preference: include source links and list breaking changes first. Claude Code can retrieve it when preparing a release summary, Cursor can use it when writing notes from merged changes, and Codex can check a summary against the same preference.',
				'The buttons on this page use example data. To try it yourself, connect two agents to the same Kody account, save a preference, and ask the other agent to find and use it.',
			],
		},
		{
			title: 'Share the facts, not every conversation',
			paragraphs: [
				'A Kody memory is a fact or preference you’ve saved. It might describe how you want release notes written, which project a nickname refers to, or where a recurring report belongs. It’s not a copy of every message in every client.',
				'Kody finds a few relevant memories when your agent searches or runs code with task context. It doesn’t load everything, so a saved fact won’t necessarily show up in every response.',
			],
		},
		{
			title: 'Choose the right home for context',
			paragraphs: [],
			table: {
				headers: ['Information', 'Keep it in'],
				rows: [
					['A preference all your agents should know', 'Kody memory'],
					[
						'Instructions for one repository or client',
						'That repository or client’s instructions',
					],
					['A job’s last processed item', 'Package storage'],
					['An API credential', 'A secret or integration'],
					[
						'The exact steps of a reusable operation',
						'Package code and documentation',
					],
				],
			},
		},
		{
			title: 'Test that memory follows you',
			paragraphs: [],
			steps: [
				'Connect two agents to the same Kody account. Choose a harmless preference you can recognize later.',
				'Ask the first agent to check existing memories, then save the preference. The agent checks what’s already saved before making a change.',
				'Ask the second agent to find the saved preference and apply it to a small task. Compare the result with what was saved.',
				'Change the preference, verify the update from the other agent, then inspect or delete the memory from your account.',
			],
		},
		{
			title: 'Memory that helps with the work',
			paragraphs: [
				'Kody keeps memory alongside your connected services and packages. Save how you like reports written, then let your agents use that context when they build and run your workflows.',
				'You can inspect and export Kody memories. Shared memory means sharing between your own connected agents, not automatically sharing private context with other people.',
			],
		},
	],
	prompt:
		'Check my existing Kody memories before saving this preference: release summaries should include the source links and list breaking changes first. Save or update the relevant memory, then show me exactly what was saved so I can verify it from another agent.',
	sources: [
		{
			label: 'Kody memory behavior and export',
			href: '/docs/memory',
		},
		{
			label: 'Where agent guidance lives',
			href: '/docs/agent-guidance',
		},
	],
	related: ['mcpGateway', 'claudeIntegrations', 'customTools'],
} satisfies AcquisitionPage
