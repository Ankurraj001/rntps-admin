import {
  BarChart3,
  CalendarCheck,
  CalendarRange,
  FilePlus2,
  IndianRupee,
  GraduationCap,
  LayoutDashboard,
  LogOut,
  MessageSquare,
  Receipt,
  Settings,
  Users,
  UserCog,
} from 'lucide-react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '@/auth/AuthProvider';
import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/utils';

interface NavItem {
  to: string;
  label: string;
  icon: typeof LayoutDashboard;
  end?: boolean;
  adminOnly?: boolean;
}

const NAV: NavItem[] = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true },
  { to: '/students', label: 'Students', icon: Users },
  { to: '/attendance', label: 'Attendance', icon: CalendarCheck },
  { to: '/attendance/monthly', label: 'Monthly view', icon: CalendarRange },
  { to: '/fees/invoices', label: 'Invoices', icon: Receipt, adminOnly: true },
  { to: '/fees/run', label: 'Generate invoices', icon: FilePlus2, adminOnly: true },
  { to: '/fees/structures', label: 'Fee structure', icon: IndianRupee, adminOnly: true },
  { to: '/notifications', label: 'Fee reminders', icon: MessageSquare, adminOnly: true },
  { to: '/reports', label: 'Reports', icon: BarChart3, adminOnly: true },
  { to: '/users', label: 'Users', icon: UserCog, adminOnly: true },
  { to: '/settings', label: 'Settings', icon: Settings, adminOnly: true },
];

const UPCOMING: { label: string; icon: typeof LayoutDashboard; phase: string }[] = [];

export function AppShell() {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();

  const isAdmin = user?.role === 'ADMIN';
  const visibleNav = NAV.filter((item) => !item.adminOnly || isAdmin);

  async function handleSignOut() {
    await signOut();
    navigate('/login', { replace: true });
  }

  return (
    <div className="flex min-h-full">
      <aside className="hidden w-60 shrink-0 flex-col border-r border-slate-200 bg-white md:flex">
        <div className="flex items-center gap-2 border-b border-slate-200 px-5 py-4">
          <GraduationCap className="h-6 w-6 text-brand-600" aria-hidden />
          <div>
            <p className="text-sm font-semibold text-slate-900">RNTPS</p>
            <p className="text-xs text-slate-500">{isAdmin ? 'Admin' : 'Teacher'}</p>
          </div>
        </div>

        <nav className="flex-1 space-y-1 p-3">
          {visibleNav.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end ?? false}
              className={({ isActive }) =>
                cn(
                  'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium',
                  isActive ? 'bg-brand-50 text-brand-700' : 'text-slate-600 hover:bg-slate-100',
                )
              }
            >
              <Icon className="h-4 w-4" aria-hidden />
              {label}
            </NavLink>
          ))}

          {/* Every planned module now exists, so this renders nothing. Kept for the next
              feature that is worth signposting before it ships. */}
          {UPCOMING.length > 0 && (
            <p className="px-3 pt-5 pb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">
              Coming next
            </p>
          )}
          {UPCOMING.map(({ label, icon: Icon, phase }) => (
            <div
              key={label}
              className="flex cursor-not-allowed items-center gap-3 rounded-md px-3 py-2 text-sm text-slate-400"
              title={`Planned for ${phase}`}
            >
              <Icon className="h-4 w-4" aria-hidden />
              {label}
              <span className="ml-auto text-[10px] uppercase">{phase.replace('Phase ', 'P')}</span>
            </div>
          ))}
        </nav>

        {user && (
          <div className="border-t border-slate-200 p-3">
            <div className="px-2 pb-2">
              <p className="truncate text-sm font-medium text-slate-900">{user.name}</p>
              <p className="truncate text-xs text-slate-500">{user.email}</p>
            </div>
            <div className="flex flex-col gap-1">
              <NavLink
                to="/change-password"
                className="rounded-md px-2 py-1.5 text-xs text-slate-600 hover:bg-slate-100"
              >
                Change password
              </NavLink>
              <Button variant="ghost" size="sm" className="justify-start" onClick={() => void handleSignOut()}>
                <LogOut className="h-4 w-4" aria-hidden />
                Sign out
              </Button>
            </div>
          </div>
        )}
      </aside>

      <main className="min-w-0 flex-1">
        <Outlet />
      </main>
    </div>
  );
}

export function PageHeader({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-4 border-b border-slate-200 bg-white px-6 py-5">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">{title}</h1>
        {description && <p className="mt-1 text-sm text-slate-500">{description}</p>}
      </div>
      {action}
    </header>
  );
}
