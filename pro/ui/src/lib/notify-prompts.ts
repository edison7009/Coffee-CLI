// Tabs where the user has sent a prompt. The completion chime waits for one before announcing a
// finished turn of a tool whose status is not native, so startup activity never sounds as a reply.
// Dependency-free, so desktop session clients can mark a send without pulling in the app state.
export const promptSubmitted = new Set<string>();

export function markPromptSubmitted(sessionId: string) {
  promptSubmitted.add(sessionId);
}
