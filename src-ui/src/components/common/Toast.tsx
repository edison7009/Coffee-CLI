import { useToast } from '../../lib/toast';
import './Toast.css';

/** The app-wide toast (lib/toast.ts), under the titlebar at the top center. */
export function Toast() {
  const toast = useToast();
  return (
    <div className="app-toast-anchor" role="status" aria-live="polite">
      {toast && <div key={toast.id} className="app-toast">{toast.text}</div>}
    </div>
  );
}
