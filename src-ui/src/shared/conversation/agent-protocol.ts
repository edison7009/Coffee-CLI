export interface AgentMessage { id: number; role: 'user' | 'assistant'; text: string; tools?: { name: string; ok: boolean }[] }
export interface AgentConversation { id: string; route: string; source: string; title: string; updatedAt: number; messageCount: number }
export interface AgentEvent { conversationId: string; runId: string; kind: string; text?: string; tool?: string }
