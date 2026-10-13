import {
  Activity,
  CalendarCheck,
  CalendarRange,
  Layers,
  LayoutDashboard,
  LogOut,
  Menu as MenuIcon,
  Plane,
  Repeat,
  Settings,
  Timer,
  UserRound,
  Users,
  X,
} from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router';
import { toast } from 'sonner';
import { api } from '../../api/client';
import { useOpenShifts, useSwaps, useTimeOffRequests } from '../../api/queries';
import { cx } from '../../lib/cx';
import { useBootstrapData, useCurrentUser, useSetSessionUser } from '../../lib/session';
import { ThemeToggle } from '../ThemeToggle';
import { Avatar } from '../ui/Misc';

interface NavItem {
  to: string;
  label: string;
  icon: ReactNode;
  end?: boolean;
  badge?: number;
}

function NavSection({
  title,
  items,
  onNavigate,
}: {
  title?: string;
  items: NavItem[];
  onNavigate: () => void;
}) {
  return (
    <div>
      {title && (
        <p className="px-3 pb-1 text-xs font-semibold uppercase tracking-wider text-slate-400">
          {title}
        </p>
      )}
      <ul className="space-y-0.5">
        {items.map((item) => (
          <li key={item.to}>
            <NavLink
              to={item.to}
              end={item.end}
              onClick={onNavigate}
              className={({ isActive }) =>
                cx(
                  'group flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition [&>svg]:size-[18px] [&>svg]:shrink-0',
                  isActive
                    ? 'bg-linear-to-r from-brand-500/15 to-transparent text-brand-700 shadow-[inset_3px_0_0_var(--color-brand-500)] [&>svg]:text-brand-600 dark:from-brand-500/25 dark:shadow-[inset_3px_0_0_#e040fb,0_0_22px_-8px_var(--glow)]'
                    : 'text-slate-600 hover:bg-slate-100/80 hover:text-slate-900 [&>svg]:text-slate-400',
                )
              }
            >
              {item.icon}
              <span className="flex-1">{item.label}</span>
              {item.badge ? (
                <span className="neon bg-neon rounded-full px-1.5 py-0.5 text-[11px] font-semibold leading-none text-white">
                  {item.badge}
                </span>
              ) : null}
            </NavLink>
          </li>
        ))}
      </ul>
    </div>
  );
}

function usePendingTimeOffCount(): number {
  const { data } = useTimeOffRequests('pending');
  return data?.length ?? 0;
}

/** Swaps the coworker agreed to, and open shifts someone picked up: waiting for an admin. */
function useSwapsToApprove(): number {
  const swaps = useSwaps();
  const openShifts = useOpenShifts();
  return (
    (swaps.data?.filter((w) => w.status === 'accepted').length ?? 0) +
    (openShifts.data?.filter((o) => o.status === 'claimed').length ?? 0)
  );
}

function Sidebar({ onNavigate }: { onNavigate: () => void }) {
  const user = useCurrentUser();
  const { org, signIn } = useBootstrapData();
  const setSessionUser = useSetSessionUser();
  const navigate = useNavigate();
  const isAdmin = user.role === 'admin';

  async function signOut() {
    try {
      await api.post('/auth/logout');
    } catch {
      toast.error("Couldn't sign out cleanly, but you're signed out on this device.");
    }
    setSessionUser(null);
    navigate('/login', { replace: true });
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-16 shrink-0 items-center gap-2.5 px-5">
        <img src="/favicon.svg" alt="" className="size-8 drop-shadow-[0_4px_12px_var(--glow)]" />
        <div className="min-w-0 leading-tight">
          <p className="truncate text-sm font-bold text-slate-900">{org.name}</p>
          <p className="text-neon text-xs font-semibold">Toretto Scheduling</p>
        </div>
      </div>
      <nav className="flex-1 space-y-6 overflow-y-auto px-3 py-4" aria-label="Main">
        <NavSection
          title={isAdmin ? 'My work' : undefined}
          onNavigate={onNavigate}
          items={[
            { to: '/my-schedule', label: 'My schedule', icon: <CalendarCheck /> },
            { to: '/team', label: 'Team schedule', icon: <Users /> },
          ]}
        />
        {isAdmin && <AdminNav onNavigate={onNavigate} />}
      </nav>
      <div className="border-t border-slate-200/70 p-3">
        <div className="mb-2 flex items-center justify-between px-2">
          <span className="text-xs font-medium text-slate-500">Theme</span>
          <ThemeToggle />
        </div>
        <NavLink
          to="/profile"
          onClick={onNavigate}
          className={({ isActive }) =>
            cx(
              'flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-slate-100/80',
              isActive && 'bg-slate-100/80',
            )
          }
        >
          <Avatar name={user.name} />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-slate-900">{user.name}</p>
            <p className="truncate text-xs text-slate-500">{user.email}</p>
          </div>
          <UserRound className="size-4 text-slate-400" aria-hidden />
        </NavLink>
        {signIn === 'password' && (
          <button
            type="button"
            onClick={() => void signOut()}
            className="mt-1 flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100/80 hover:text-slate-900"
          >
            <LogOut className="size-[18px] text-slate-400" /> Sign out
          </button>
        )}
      </div>
    </div>
  );
}

function AdminNav({ onNavigate }: { onNavigate: () => void }) {
  const pending = usePendingTimeOffCount();
  const swaps = useSwapsToApprove();
  return (
    <NavSection
      title="Manage"
      onNavigate={onNavigate}
      items={[
        { to: '/admin', label: 'Dashboard', icon: <LayoutDashboard />, end: true },
        { to: '/admin/schedules', label: 'Schedules', icon: <CalendarRange /> },
        { to: '/admin/time-off', label: 'Time off', icon: <Plane />, badge: pending },
        {
          to: '/admin/shift-requests',
          label: 'Swaps & open shifts',
          icon: <Repeat />,
          badge: swaps,
        },
        { to: '/admin/hours', label: 'Hours', icon: <Timer /> },
        { to: '/admin/people', label: 'People', icon: <Users /> },
        { to: '/admin/tiers', label: 'Tiers & labels', icon: <Layers /> },
        { to: '/admin/activity', label: 'Activity', icon: <Activity /> },
        { to: '/admin/settings', label: 'Settings', icon: <Settings /> },
      ]}
    />
  );
}

export function AppShell() {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const { org } = useBootstrapData();
  return (
    <div className="min-h-dvh">
      {/* Desktop sidebar */}
      <aside className="glass fixed inset-y-0 left-0 z-20 hidden w-64 border-r border-slate-200/70 lg:block">
        <Sidebar onNavigate={() => undefined} />
      </aside>

      {/* Mobile top bar + drawer */}
      <header className="glass sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-slate-200/70 px-4 lg:hidden">
        <button
          type="button"
          aria-label="Open menu"
          onClick={() => setDrawerOpen(true)}
          className="-ml-2 rounded-lg p-2 text-slate-600 hover:bg-slate-100"
        >
          <MenuIcon className="size-5" />
        </button>
        <img src="/favicon.svg" alt="" className="size-7" />
        <p className="truncate text-sm font-bold">{org.name}</p>
      </header>
      {drawerOpen && (
        <div
          className="fixed inset-0 z-40 lg:hidden"
          role="dialog"
          aria-modal="true"
          aria-label="Menu"
        >
          <div
            className="absolute inset-0 bg-[rgb(10_8_24/0.45)] backdrop-blur-sm"
            onClick={() => setDrawerOpen(false)}
          />
          <div className="absolute inset-y-0 left-0 w-72 max-w-[85vw] bg-surface/95 shadow-xl backdrop-blur-xl">
            <button
              type="button"
              aria-label="Close menu"
              onClick={() => setDrawerOpen(false)}
              className="absolute top-4 right-3 rounded-lg p-1.5 text-slate-500 hover:bg-slate-100"
            >
              <X className="size-5" />
            </button>
            <Sidebar onNavigate={() => setDrawerOpen(false)} />
          </div>
        </div>
      )}

      <main className="lg:pl-64">
        <div className="mx-auto max-w-[1400px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
