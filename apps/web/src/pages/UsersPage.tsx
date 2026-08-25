import { CLASS_CODES, USER_ROLES, classLabel, type UserDto, type CreateUserInput } from '@rntps/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, Eye, KeyRound, LockOpen, Plus, UserX } from 'lucide-react';
import { useState } from 'react';
import { userKeys, usersApi } from '@/api/auth';
import { useCurrentUser } from '@/auth/AuthProvider';
import { PageHeader } from '@/components/layout/AppShell';
import { Badge, StatusBadge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { ErrorBlock, LoadingBlock, Spinner } from '@/components/ui/Feedback';
import { Field, Input, Select } from '@/components/ui/Field';

export function UsersPage() {
  const me = useCurrentUser();
  const queryClient = useQueryClient();
  const [isAdding, setIsAdding] = useState(false);
  const [handover, setHandover] = useState<{ email: string; password: string } | null>(null);

  const users = useQuery({ queryKey: userKeys.all, queryFn: usersApi.list });
  const invalidate = () => queryClient.invalidateQueries({ queryKey: userKeys.all });

  const deactivate = useMutation({ mutationFn: usersApi.deactivate, onSuccess: invalidate });
  const activate = useMutation({ mutationFn: usersApi.activate, onSuccess: invalidate });
  const unlock = useMutation({ mutationFn: usersApi.unlock, onSuccess: invalidate });
  const reset = useMutation({
    mutationFn: usersApi.resetPassword,
    onSuccess: async (result) => {
      if (result.temporaryPassword) {
        setHandover({ email: result.user.email, password: result.temporaryPassword });
      }
      await invalidate();
    },
  });

  const mutationError = deactivate.error ?? activate.error ?? unlock.error ?? reset.error;

  return (
    <>
      <PageHeader
        title="Users"
        description="Admins manage everything; teachers mark attendance for their assigned classes."
        action={
          <Button onClick={() => setIsAdding((open) => !open)}>
            <Plus className="h-4 w-4" aria-hidden />
            Add user
          </Button>
        }
      />

      <div className="space-y-5 p-6">
        {mutationError && <ErrorBlock message={(mutationError as Error).message} />}

        {handover && (
          <TemporaryPasswordCard
            email={handover.email}
            password={handover.password}
            onDismiss={() => setHandover(null)}
          />
        )}

        {isAdding && (
          <AddUserForm
            onDone={(result) => {
              setIsAdding(false);
              if (result) setHandover(result);
              void invalidate();
            }}
          />
        )}

        <Card>
          {users.isPending && <LoadingBlock />}
          {users.error && <div className="p-4"><ErrorBlock message={(users.error as Error).message} /></div>}

          {users.data && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                  <tr>
                    <th scope="col" className="px-5 py-3 font-medium">Name</th>
                    <th scope="col" className="px-5 py-3 font-medium">Role</th>
                    <th scope="col" className="px-5 py-3 font-medium">Classes</th>
                    <th scope="col" className="px-5 py-3 font-medium">Last sign-in</th>
                    <th scope="col" className="px-5 py-3 font-medium">Status</th>
                    <th scope="col" className="px-5 py-3 font-medium sr-only">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {users.data.items.map((user) => (
                    <UserRow
                      key={user.id}
                      user={user}
                      isSelf={user.id === me.id}
                      busy={reset.isPending || deactivate.isPending || activate.isPending || unlock.isPending}
                      onReset={() => reset.mutate(user.id)}
                      onUnlock={() => unlock.mutate(user.id)}
                      onToggleActive={() =>
                        user.isActive ? deactivate.mutate(user.id) : activate.mutate(user.id)
                      }
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </>
  );
}

function UserRow({
  user,
  isSelf,
  busy,
  onReset,
  onUnlock,
  onToggleActive,
}: {
  user: UserDto;
  isSelf: boolean;
  busy: boolean;
  onReset: () => void;
  onUnlock: () => void;
  onToggleActive: () => void;
}) {
  const [revealed, setRevealed] = useState<string | null>(null);
  const [revealError, setRevealError] = useState<string | null>(null);

  const reveal = useMutation({
    mutationFn: () => usersApi.revealPassword(user.id),
    onSuccess: (result) => {
      setRevealError(null);
      setRevealed(result.password);
    },
    onError: (error) => setRevealError((error as Error).message),
  });

  return (
    <tr className="hover:bg-slate-50">
      <td className="px-5 py-3">
        <span className="font-medium text-slate-900">{user.name}</span>
        {isSelf && <span className="ml-2 text-xs text-slate-400">(you)</span>}
        <span className="block text-xs text-slate-500">{user.email}</span>
      </td>
      <td className="px-5 py-3">
        <Badge tone={user.role === 'ADMIN' ? 'blue' : 'slate'}>
          {user.role === 'ADMIN' ? 'Admin' : 'Teacher'}
        </Badge>
      </td>
      <td className="px-5 py-3 text-slate-600">
        {user.role === 'ADMIN'
          ? 'All'
          : user.assignedClasses.map((c) => classLabel(c)).join(', ') || '—'}
      </td>
      <td className="px-5 py-3 text-slate-600">
        {user.lastLoginAt ? new Date(user.lastLoginAt).toLocaleDateString('en-IN') : 'Never'}
      </td>
      <td className="px-5 py-3">
        <div className="flex flex-wrap gap-1">
          <StatusBadge status={user.isActive ? 'ACTIVE' : 'INACTIVE'} />
          {user.isLocked && <Badge tone="red">Locked</Badge>}
          {user.mustChangePassword && <Badge tone="amber">Temp password</Badge>}
        </div>
      </td>
      <td className="px-5 py-3">
        {revealed && (
          <p className="mb-1 text-right">
            <code className="rounded border border-slate-300 bg-slate-50 px-2 py-1 font-mono text-xs">
              {revealed}
            </code>
          </p>
        )}
        {revealError && <p className="mb-1 text-right text-xs text-amber-700">{revealError}</p>}

        <div className="flex justify-end gap-1">
          <Button
            variant="ghost"
            size="sm"
            disabled={busy || reveal.isPending}
            onClick={() => (revealed ? setRevealed(null) : reveal.mutate())}
          >
            {reveal.isPending ? <Spinner /> : <Eye className="h-4 w-4" aria-hidden />}
            {revealed ? 'Hide' : 'Password'}
          </Button>
          {user.isLocked && (
            <Button variant="ghost" size="sm" disabled={busy} onClick={onUnlock}>
              <LockOpen className="h-4 w-4" aria-hidden />
              Unlock
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => {
              // Resetting your own password signs you out and forces a change, with the
              // new password shown exactly once. Worth a confirmation.
              if (isSelf && !window.confirm(
                'Reset your own password?\n\nYou will be signed out and must set a new password. The temporary password is shown only once.',
              )) return;
              onReset();
            }}
          >
            <KeyRound className="h-4 w-4" aria-hidden />
            Reset
          </Button>
          {/* Self-deactivation is blocked server-side too; hiding it avoids a pointless error. */}
          {!isSelf && (
            <Button variant="ghost" size="sm" disabled={busy} onClick={onToggleActive}>
              <UserX className="h-4 w-4" aria-hidden />
              {user.isActive ? 'Deactivate' : 'Activate'}
            </Button>
          )}
        </div>
      </td>
    </tr>
  );
}

/** Shown once — the server never returns a password again after this. */
function TemporaryPasswordCard({
  email,
  password,
  onDismiss,
}: {
  email: string;
  password: string;
  onDismiss: () => void;
}) {
  const [copied, setCopied] = useState(false);

  return (
    <Card className="border-amber-300 bg-amber-50">
      <CardBody className="space-y-3">
        <div>
          <p className="text-sm font-medium text-slate-900">Temporary password for {email}</p>
          <p className="text-xs text-slate-600">
            Shown once. Hand it over directly — they will be asked to change it at first sign-in.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <code className="rounded border border-amber-300 bg-white px-3 py-2 font-mono text-sm">{password}</code>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              void navigator.clipboard.writeText(password).then(() => setCopied(true));
            }}
          >
            <Copy className="h-4 w-4" aria-hidden />
            {copied ? 'Copied' : 'Copy'}
          </Button>
          <Button variant="ghost" size="sm" onClick={onDismiss}>
            Done
          </Button>
        </div>
      </CardBody>
    </Card>
  );
}

function AddUserForm({
  onDone,
}: {
  onDone: (result: { email: string; password: string } | null) => void;
}) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'ADMIN' | 'TEACHER'>('TEACHER');
  const [classes, setClasses] = useState<string[]>([]);

  const create = useMutation({
    mutationFn: () =>
      usersApi.create({
        name,
        email,
        role,
        assignedClasses: role === 'ADMIN' ? [] : classes,
      } as CreateUserInput),
    onSuccess: (result) => {
      onDone(
        result.temporaryPassword ? { email: result.user.email, password: result.temporaryPassword } : null,
      );
    },
  });

  function toggleClass(code: string) {
    setClasses((current) =>
      current.includes(code) ? current.filter((c) => c !== code) : [...current, code],
    );
  }

  return (
    <Card>
      <CardHeader title="Add user" description="A temporary password is generated for you to hand over." />
      <CardBody className="space-y-4">
        {create.error && <ErrorBlock message={(create.error as Error).message} />}

        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Full name" required>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Email" required>
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <Field label="Role" required>
            <Select value={role} onChange={(e) => setRole(e.target.value as 'ADMIN' | 'TEACHER')}>
              {USER_ROLES.map((value) => (
                <option key={value} value={value}>
                  {value === 'ADMIN' ? 'Admin' : 'Teacher'}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        {role === 'TEACHER' && (
          <Field label="Assigned classes" required hint="A teacher can only mark attendance for these.">
            <div className="flex flex-wrap gap-2 pt-1">
              {CLASS_CODES.map((code) => (
                <label
                  key={code}
                  className="flex cursor-pointer items-center gap-1.5 rounded-md border border-slate-300 px-2.5 py-1.5 text-sm hover:bg-slate-50"
                >
                  <input type="checkbox" checked={classes.includes(code)} onChange={() => toggleClass(code)} />
                  {classLabel(code)}
                </label>
              ))}
            </div>
          </Field>
        )}

        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={() => onDone(null)}>
            Cancel
          </Button>
          <Button
            onClick={() => create.mutate()}
            disabled={create.isPending || !name || !email || (role === 'TEACHER' && classes.length === 0)}
          >
            {create.isPending && <Spinner />}
            Create user
          </Button>
        </div>
      </CardBody>
    </Card>
  );
}
