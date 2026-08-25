import { createBrowserRouter } from 'react-router-dom';
import { RequireAuth, RequireRole } from '@/auth/RouteGuards';
import { AppShell } from '@/components/layout/AppShell';
import { ChangePasswordPage } from '@/pages/ChangePasswordPage';
import { MarkAttendancePage } from '@/pages/attendance/MarkAttendancePage';
import { FeeStructuresPage } from '@/pages/fees/FeeStructuresPage';
import { InvoiceDetailPage } from '@/pages/fees/InvoiceDetailPage';
import { InvoiceRunPage } from '@/pages/fees/InvoiceRunPage';
import { InvoicesPage } from '@/pages/fees/InvoicesPage';
import { FeeSlipPage } from '@/pages/fees/FeeSlipPage';
import { ReceiptPage } from '@/pages/fees/ReceiptPage';
import { NotificationsPage } from '@/pages/notifications/NotificationsPage';
import { ReportsPage } from '@/pages/reports/ReportsPage';
import { MonthlyAttendancePage } from '@/pages/attendance/MonthlyAttendancePage';
import { DashboardPage } from '@/pages/DashboardPage';
import { ForgotPasswordPage } from '@/pages/ForgotPasswordPage';
import { LoginPage } from '@/pages/LoginPage';
import { ResetPasswordPage } from '@/pages/ResetPasswordPage';
import { NotFoundPage } from '@/pages/NotFoundPage';
import { SettingsPage } from '@/pages/SettingsPage';
import { UsersPage } from '@/pages/UsersPage';
import { StudentDetailPage } from '@/pages/students/StudentDetailPage';
import { StudentFormPage } from '@/pages/students/StudentFormPage';
import { StudentsListPage } from '@/pages/students/StudentsListPage';

/** Admin-only pages are wrapped here as well as guarded by the API. */
const adminOnly = (element: React.ReactNode) => <RequireRole role="ADMIN">{element}</RequireRole>;

export const router = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
  // Public: a user who cannot sign in has to be able to reach these.
  { path: '/forgot-password', element: <ForgotPasswordPage /> },
  { path: '/reset-password', element: <ResetPasswordPage /> },
  {
    // Outside the shell: a user with a temporary password should not see the navigation.
    path: '/change-password',
    element: (
      <RequireAuth>
        <ChangePasswordPage />
      </RequireAuth>
    ),
  },
  {
    path: '/',
    element: (
      <RequireAuth>
        <AppShell />
      </RequireAuth>
    ),
    children: [
      { index: true, element: <DashboardPage /> },
      { path: 'students', element: <StudentsListPage /> },
      { path: 'students/new', element: adminOnly(<StudentFormPage mode="create" />) },
      { path: 'students/:studentId', element: <StudentDetailPage /> },
      { path: 'students/:studentId/edit', element: adminOnly(<StudentFormPage mode="edit" />) },
      { path: 'attendance', element: <MarkAttendancePage /> },
      { path: 'attendance/monthly', element: <MonthlyAttendancePage /> },
      { path: 'fees/structures', element: adminOnly(<FeeStructuresPage />) },
      { path: 'fees/run', element: adminOnly(<InvoiceRunPage />) },
      { path: 'fees/invoices', element: adminOnly(<InvoicesPage />) },
      { path: 'fees/invoices/:invoiceId', element: adminOnly(<InvoiceDetailPage />) },
      { path: 'fees/invoices/:invoiceId/slip', element: adminOnly(<FeeSlipPage />) },
      { path: 'fees/receipts/:invoiceId/:receiptNo', element: adminOnly(<ReceiptPage />) },
      { path: 'notifications', element: adminOnly(<NotificationsPage />) },
      { path: 'reports', element: adminOnly(<ReportsPage />) },
      { path: 'users', element: adminOnly(<UsersPage />) },
      { path: 'settings', element: adminOnly(<SettingsPage />) },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
]);
