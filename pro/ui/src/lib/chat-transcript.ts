export type ChatRole = 'user' | 'assistant' | 'reasoning' | 'tool' | 'notice';

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  toolName?: string;
  toolStatus?: 'running' | 'done' | 'failed';
}
