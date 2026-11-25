// Synchronous platform checks for first-paint layout decisions.
//
// The frameless titlebar must decide on the very first render whether the
// window controls live on the right (Windows/Linux — our custom min/max/close)
// or are owned by the OS on the left (macOS native traffic lights, enabled via
// titleBarStyle: "Overlay" in tauri.macos.conf.json). CSS likewise needs to
// know up front whether to drop our custom rounded #root shell: on macOS the
// native window decorations own the corners, so the 10px clip must go.
//
// navigator.platform is deprecated but reliable inside the Tauri WebView;
// userAgentData.platform is the modern equivalent. Both are read once,
// synchronously, so the decision is available before React mounts (the
// alternative — @tauri-apps/plugin-os which is async — would land after the
// first paint and flash the wrong chrome).
function detectPlatform(needle: string): boolean {
  try {
    const ua = (navigator as unknown as { userAgentData?: { platform?: string } }).userAgentData;
    const platform = (ua?.platform || navigator.platform || '').toLowerCase();
    return platform.includes(needle);
  } catch {
    return false;
  }
}

export const IS_MACOS: boolean = detectPlatform('mac');
// Windows navigator.platform is "Win32", userAgentData.platform is "Windows".
// Used by the shell picker to decide between the Windows (pwsh/cmd/git-bash)
// and Unix (zsh/bash/fish/sh) candidate sets.
export const IS_WINDOWS: boolean = detectPlatform('win');
