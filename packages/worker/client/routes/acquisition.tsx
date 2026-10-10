import { UseCasesPage } from './acquisition/useCases.tsx'
import { type Handle } from 'remix/component'
import { N8nAlternativesPage } from './acquisition/n8nAlternatives.tsx'
import { McpGatewayPage } from './acquisition/mcpGateway.tsx'
import { SharedMemoryPage } from './acquisition/sharedMemory.tsx'
import { GmailPage } from './acquisition/gmail.tsx'
import { CustomToolsPage } from './acquisition/customTools.tsx'
import { ComposioAlternativesPage } from './acquisition/composioAlternatives.tsx'
import { SlackPage } from './acquisition/slack.tsx'
import { ScheduledWorkflowsPage } from './acquisition/scheduledWorkflows.tsx'
import { ClaudeIntegrationsPage } from './acquisition/claudeIntegrations.tsx'
import { AutomationPage } from './acquisition/automation.tsx'

export function AcquisitionRoute(handle: Handle<{ pageKey: string }>) {
	return () => {
		switch (handle.props.pageKey) {
			case 'useCases':
				return <UseCasesPage />
			case 'n8nAlternatives':
				return <N8nAlternativesPage />
			case 'mcpGateway':
				return <McpGatewayPage />
			case 'sharedMemory':
				return <SharedMemoryPage />
			case 'gmail':
				return <GmailPage />
			case 'customTools':
				return <CustomToolsPage />
			case 'composioAlternatives':
				return <ComposioAlternativesPage />
			case 'slack':
				return <SlackPage />
			case 'scheduledWorkflows':
				return <ScheduledWorkflowsPage />
			case 'claudeIntegrations':
				return <ClaudeIntegrationsPage />
			case 'automation':
				return <AutomationPage />
			default:
				return null
		}
	}
}
