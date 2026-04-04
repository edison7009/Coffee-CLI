// main.tsx — Entry point

import React from 'react';
import ReactDOM from 'react-dom/client';
import { AppProvider } from './store/app-state';
import { App } from './App';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AppProvider>
      <App />
    </AppProvider>
  </React.StrictMode>
);
