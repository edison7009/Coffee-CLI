// island-entry.tsx — Entry point for the system-level Dynamic Island overlay window
import { createRoot } from 'react-dom/client';
import { IslandOverlay } from './components/island/IslandOverlay';
import { AppProvider } from './store/app-state';

const root = document.getElementById('island-root');

// Disable browser context menu on the island overlay
document.addEventListener('contextmenu', (e) => e.preventDefault());

// DEBUG: verify mouse events reach the WebView
document.addEventListener('mousedown', (e) => {
  console.log('[Island-Entry] mousedown button=', e.button, 'x=', e.clientX, 'y=', e.clientY);
});
document.addEventListener('dblclick', (e) => {
  console.log('[Island-Entry] dblclick x=', e.clientX, 'y=', e.clientY);
});
document.addEventListener('click', (e) => {
  console.log('[Island-Entry] click x=', e.clientX, 'y=', e.clientY);
});

if (root) {
  createRoot(root).render(
    <AppProvider>
      <IslandOverlay />
    </AppProvider>
  );
}
