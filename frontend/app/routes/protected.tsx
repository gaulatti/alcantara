import { Outlet } from 'react-router';
import ProtectedRoute from '../components/common/ProtectedRoute';

export default function ProtectedLayout() {
  return (
    <ProtectedRoute>
      <Outlet />
    </ProtectedRoute>
  );
}
