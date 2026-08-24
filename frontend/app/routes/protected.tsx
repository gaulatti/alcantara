import { Outlet } from 'react-router';
import ProtectedRoute from '../components/common/ProtectedRoute';
import { FeaturesProvider } from '../hooks/useFeatures';

export default function ProtectedLayout() {
  return (
    <ProtectedRoute>
      <FeaturesProvider>
        <Outlet />
      </FeaturesProvider>
    </ProtectedRoute>
  );
}
