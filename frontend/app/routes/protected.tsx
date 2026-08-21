import { Outlet } from 'react-router';
import ProtectedRoute from '../components/common/ProtectedRoute';
import PermissionBoundary from '../components/common/PermissionBoundary';
import { FeaturesProvider } from '../hooks/useFeatures';

export default function ProtectedLayout() {
  return (
    <ProtectedRoute>
      <FeaturesProvider>
        <PermissionBoundary>
          <Outlet />
        </PermissionBoundary>
      </FeaturesProvider>
    </ProtectedRoute>
  );
}
