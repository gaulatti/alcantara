import { Outlet } from 'react-router';
import ProtectedRoute from '../components/common/ProtectedRoute';
import { FeaturesProvider } from '../hooks/useFeatures';
import { ConsolePreferencesProvider } from '../contexts/ConsolePreferencesContext';

export default function ProtectedLayout() {
  return (
    <ProtectedRoute>
      <FeaturesProvider>
        <ConsolePreferencesProvider>
          <Outlet />
        </ConsolePreferencesProvider>
      </FeaturesProvider>
    </ProtectedRoute>
  );
}
