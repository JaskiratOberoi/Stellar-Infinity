import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { AuthProvider } from './auth/AuthContext';
import { App } from './App';
import './styles.css';
import { startThemeClock } from './theme/theme';

// Day theme by day, night theme by night — IST, the lab's own clock. The
// print entry never runs this: a report photographed at 3am must not come
// out dark. See theme.ts for how a person outranks the clock.
startThemeClock();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <App />
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
);
