import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App.tsx';
import { AuthProvider } from './auth.tsx';
import { ToastProvider } from './components/ui.tsx';
import { applyTheme, savedTheme } from './pages/Settings.tsx';
import { UploadProvider } from './uploads.tsx';
import './styles.css';

applyTheme(savedTheme());
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <ToastProvider>
        <AuthProvider>
          <UploadProvider>
            <App />
          </UploadProvider>
        </AuthProvider>
      </ToastProvider>
    </BrowserRouter>
  </StrictMode>,
);
