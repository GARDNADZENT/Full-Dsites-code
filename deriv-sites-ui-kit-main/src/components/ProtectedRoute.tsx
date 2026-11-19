import { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { Loader2 } from 'lucide-react';
import { buildSignInUrl } from '@/lib/auth-redirect';

interface ProtectedRouteProps {
  children: ReactNode;
}

export default function ProtectedRoute({ children }: ProtectedRouteProps) {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (!user) {
    // Remember the attempted destination so signing in returns here rather than
    // dropping the visitor on the tenant dashboard.
    const attemptedPath = `${location.pathname}${location.search}${location.hash}`;
    return <Navigate to={buildSignInUrl(attemptedPath)} replace />;
  }

  return <>{children}</>;
}
