import { type ScreenKind } from '../../app-grid.ts'
import {
	BookingScreen,
	BudgetScreen,
	ChoresScreen,
	GroceryScreen,
	HomeScreen,
	JournalScreen,
	PhotosScreen,
	RouteScreen,
} from './life-screens.tsx'
import { type ScreenProps } from './parts.tsx'
import {
	FlashcardScreen,
	HabitScreen,
	PlayerScreen,
	PollScreen,
	SeatScreen,
	SketchScreen,
	TimerScreen,
	WordScreen,
} from './play-screens.tsx'
import {
	ApprovalsScreen,
	CallScreen,
	ChatScreen,
	DiffScreen,
	EditorScreen,
	InvoiceScreen,
	KanbanScreen,
	TerminalScreen,
} from './work-screens.tsx'

export function AppScreen({
	screen,
	...props
}: ScreenProps & { screen: ScreenKind }) {
	switch (screen) {
		case 'approvals':
			return <ApprovalsScreen {...props} />
		case 'booking':
			return <BookingScreen {...props} />
		case 'budget':
			return <BudgetScreen {...props} />
		case 'call':
			return <CallScreen {...props} />
		case 'chat':
			return <ChatScreen {...props} />
		case 'chores':
			return <ChoresScreen {...props} />
		case 'diff':
			return <DiffScreen {...props} />
		case 'editor':
			return <EditorScreen {...props} />
		case 'flashcards':
			return <FlashcardScreen {...props} />
		case 'grocery':
			return <GroceryScreen {...props} />
		case 'habit':
			return <HabitScreen {...props} />
		case 'home':
			return <HomeScreen {...props} />
		case 'invoice':
			return <InvoiceScreen {...props} />
		case 'journal':
			return <JournalScreen {...props} />
		case 'kanban':
			return <KanbanScreen {...props} />
		case 'photos':
			return <PhotosScreen {...props} />
		case 'player':
			return <PlayerScreen {...props} />
		case 'poll':
			return <PollScreen {...props} />
		case 'route':
			return <RouteScreen {...props} />
		case 'seat':
			return <SeatScreen {...props} />
		case 'sketch':
			return <SketchScreen {...props} />
		case 'terminal':
			return <TerminalScreen {...props} />
		case 'timer':
			return <TimerScreen {...props} />
		case 'word':
			return <WordScreen {...props} />
		default: {
			const unhandled: never = screen
			throw new Error(`Unhandled screen: ${String(unhandled)}`)
		}
	}
}
