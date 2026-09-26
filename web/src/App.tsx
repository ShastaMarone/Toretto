import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes } from 'react-router';
import { AppShell } from './components/layout/AppShell';
import { EmptyState, FullPageSpinner } from './components/ui/Misc';
import { ButtonLink } from './components/ui/Button';
import { BootstrapGate, PublicOnly, RequireAdmin, RequireAuth } from './components/RouteGuards';
import { homePath, useCurrentUser } from './lib/session';
import CheckEmailPage from './pages/auth/CheckEmailPage';
import LoginPage from './pages/auth/LoginPage';
import SetupPage from './pages/auth/SetupPage';
import SignupPage from './pages/auth/SignupPage';
import { ForgotPasswordPage, MagicLinkPage, SetPasswordPage } from './pages/auth/TokenPages';
import { ConfirmScheduleShiftsPage, ConfirmShiftPage } from './pages/ConfirmPages';
import MySchedulePage from './pages/member/MySchedulePage';
import ProfilePage from './pages/member/ProfilePage';
import TeamSchedulePage from './pages/member/TeamSchedulePage';

// Admin screens are split into their own chunk; most people never load them.
const DashboardPage = lazy(() => import('./pages/admin/DashboardPage'));
const SchedulesPage = lazy(() => import('./pages/admin/SchedulesPage'));
const ScheduleBuilderPage = lazy(() => import('./pages/admin/ScheduleBuilderPage'));
const TimeOffAdminPage = lazy(() => import('./pages/admin/TimeOffAdminPage'));
const PeoplePage = lazy(() => import('./pages/admin/PeoplePage'));
const TiersLabelsPage = lazy(() => import('./pages/admin/TiersLabelsPage'));
const ActivityPage = lazy(() => import('./pages/admin/ActivityPage'));
const SettingsPage = lazy(() => import('./pages/admin/SettingsPage'));
const DevMailboxPage = lazy(() => import('./pages/DevMailboxPage'));

function Home() {
  const user = useCurrentUser();
  return <Navigate to={homePath(user)} replace />;
}

function NotFound() {
  return (
    <EmptyState
      title="Page not found"
      description="The link may be broken or the page may have moved."
      action={
        <ButtonLink to="/" variant="primary">
          Go home
        </ButtonLink>
      }
      className="min-h-[60dvh] justify-center"
    />
  );
}

export default function App() {
  return (
    <BootstrapGate>
      <Suspense fallback={<FullPageSpinner />}>
        <Routes>
          <Route element={<PublicOnly />}>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/signup" element={<SignupPage />} />
            <Route path="/forgot-password" element={<ForgotPasswordPage />} />
          </Route>
          <Route path="/setup" element={<SetupPage />} />
          <Route path="/check-email" element={<CheckEmailPage />} />
          <Route path="/magic-link" element={<MagicLinkPage />} />
          <Route path="/set-password" element={<SetPasswordPage />} />
          <Route path="/dev/mailbox" element={<DevMailboxPage />} />
          <Route
            element={
              <RequireAuth>
                <AppShell />
              </RequireAuth>
            }
          >
            <Route index element={<Home />} />
            <Route path="/my-schedule" element={<MySchedulePage />} />
            <Route path="/team" element={<TeamSchedulePage />} />
            <Route path="/profile" element={<ProfilePage />} />
            <Route path="/confirm-shift/:id" element={<ConfirmShiftPage />} />
            <Route path="/confirm-shifts/:scheduleId" element={<ConfirmScheduleShiftsPage />} />
            <Route path="/admin" element={<RequireAdmin />}>
              <Route index element={<DashboardPage />} />
              <Route path="schedules" element={<SchedulesPage />} />
              <Route path="schedules/:id" element={<ScheduleBuilderPage />} />
              <Route path="time-off" element={<TimeOffAdminPage />} />
              <Route path="people" element={<PeoplePage />} />
              <Route path="tiers" element={<TiersLabelsPage />} />
              <Route path="activity" element={<ActivityPage />} />
              <Route path="settings" element={<SettingsPage />} />
            </Route>
            <Route path="*" element={<NotFound />} />
          </Route>
        </Routes>
      </Suspense>
    </BootstrapGate>
  );
}
