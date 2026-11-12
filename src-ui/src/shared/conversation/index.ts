// Pure conversation state shared by the desktop UI and the mobile app.
// Nothing here may import React, Tauri, the DOM or anything outside this folder.
export * as claude from './claude-protocol';
export * as codex from './codex-protocol';
export * as opencode from './opencode-protocol';
export * as pi from './pi-protocol';
export * as dsh from './dsh-protocol';
export * as transcript from './chat-transcript';
