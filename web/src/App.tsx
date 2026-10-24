import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './auth.tsx';
import { Layout } from './components/Layout.tsx';
import { Spinner } from './components/ui.tsx';
import { AdminPage } from './pages/Admin.tsx';
import { HomePage } from './pages/Home.tsx';
import { LoginPage, ResetPage } from './pages/Login.tsx';
import { OpenPage } from './pages/Open.tsx';
import { ProfilePage, SettingsPage } from './pages/Settings.tsx';
import { FilesPage, SearchPage, ViewPage } from './pages/Views.tsx';

export function App() {
  const { user, loading } = useAuth();
  if (loading) return <div className="boot"><Spinner label="Loading" /></div>;
  return (
    <Routes>
      <Route path="/reset" element={<ResetPage />} />
      {!user ? <Route path="*" element={<LoginPage />} /> : (
        <Route element={<Layout />}>
          <Route index element={<HomePage />} />
          <Route path="files" element={<FilesPage />} />
          <Route path="files/:folderId" element={<FilesPage />} />
          <Route path="shared" element={<ViewPage view="shared" />} />
          <Route path="recent" element={<ViewPage view="recent" />} />
          <Route path="starred" element={<ViewPage view="starred" />} />
          <Route path="trash" element={<ViewPage view="trash" />} />
          <Route path="search" element={<SearchPage />} />
          <Route path="open/:id" element={<OpenPage />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="profile" element={<ProfilePage />} />
          {user.role === 'admin' && <Route path="admin" element={<AdminPage />} />}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      )}
    </Routes>
  );
}
