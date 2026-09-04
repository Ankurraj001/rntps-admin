import {
  CLASS_CODES,
  USER_ROLES,
  classLabel,
  type ClassCode,
  type UserDto,
  type CreateUserInput,
} from '@rntps/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, LockOpen, Pencil, Plus, UserX } from 'lucide-react';
import { useState } from 'react';
import { userKeys, usersApi, type UserHandoverResult } from '@/api/auth';
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
  const [editingId, setEditingId] = useState<string | null>(null);
  const [handover, setHandover] = useState<Handover | null>(null);

  const users = useQuery({ queryKey: userKeys.all, queryFn: usersApi.list });
  const invalidate = () => queryClient.invalidateQueries({ queryKey: userKeys.all });

  const deactivate = useMutation({ mutationFn: usersApi.deactivate, onSuccess: invalidate });
  const activate = useMutation({ mutationFn: usersApi.activate, onSuccess: invalidate });
  const unlock = useMutation({ mutationFn: usersApi.unlock, onSuccess: invalidate });

  const mutationError = deactivate.error ?? activate.error ?? unlock.error;

  // Editing is driven by id rather than the row's object so the open form always reflects
  // the latest list data after a save elsewhere on the page.
  const editing = users.data?.items.find((user) => user.id === editingId) ?? null;

  return (
    <>
      <PageHeader
        title="Users"
        description="Admins manage everything; teachers mark attendance for their assigned classes."
        action={
          <Button
            onClick={() => {
              setEditingId(null);
              setIsAdding((open) => !open);
            }}
          >
            <Plus className="h-4 w-4" aria-hidden />
            Add user
          </Button>
        }
      />

      <div className="space-y-5 p-6">
        {mutationError && <ErrorBlock message={(mutationError as Error).message} />}

        {handover && <HandoverCard handover={handover} onDismiss={() => setHandover(null)} />}

        {isAdding && (
          <AddUserForm
            onDone={(result) => {
              setIsAdding(false);
              if (result) setHandover(result);
              void invalidate();
            }}
          />
        )}

        {editing && (
          <EditUserForm
            key={editing.id}
            user={editing}
            onDone={() => {
              setEditingId(null);
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
                      isEditing={user.id === editingId}
                      busy={deactivate.isPending || activate.isPending || unlock.isPending}
                      onEdit={() => {
                        setIsAdding(false);
                        setEditingId((current) => (current === user.id ? null : user.id));
                      }}
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
  isEditing,
  busy,
  onEdit,
  onUnlock,
  onToggleActive,
}: {
  user: UserDto;
  isSelf: boolean;
  isEditing: boolean;
  busy: boolean;
  onEdit: () => void;
  onUnlock: () => void;
  onToggleActive: () => void;
}) {
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
          {/* A mistyped address is otherwise invisible until someone reports never getting
              mail — and it is the address every recovery link is sent to. */}
          {!user.emailVerifiedAt && <Badge tone="slate">Email unconfirmed</Badge>}
        </div>
      </td>
      <td className="px-5 py-3">
        <div className="flex justify-end gap-1">
          {user.isLocked && (
            <Button variant="ghost" size="sm" disabled={busy} onClick={onUnlock}>
              <LockOpen className="h-4 w-4" aria-hidden />
              Unlock
            </Button>
          )}
          {/* No reset here on purpose: a user recovers their own password through
              "Forgotten password", so nobody else needs to handle it. */}
          {/* Admins have nothing this form can usefully change — they already reach every
              class — so the row offers no Edit. Promoting a teacher is therefore one-way
              from here; demoting one back needs a direct PATCH /users/:userId. */}
          {user.role !== 'ADMIN' && (
            <Button variant="ghost" size="sm" onClick={onEdit} aria-expanded={isEditing}>
              <Pencil className="h-4 w-4" aria-hidden />
              {isEditing ? 'Close' : 'Edit'}
            </Button>
          )}
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

/**
 * What happened when an account was created or reset, and what the admin must do next.
 *
 * Two outcomes, because either the user was emailed a link — in which case there is no
 * password for anyone to handle — or mail was unavailable and a one-time password has to be
 * passed on by hand.
 */
export type Handover =
  | { kind: 'invited'; email: string }
  | { kind: 'password'; email: string; password: string };

export function handoverFrom(result: UserHandoverResult): Handover | null {
  if (result.invited) return { kind: 'invited', email: result.user.email };
  if (result.temporaryPassword) {
    return { kind: 'password', email: result.user.email, password: result.temporaryPassword };
  }
  return null;
}

function HandoverCard({ handover, onDismiss }: { handover: Handover; onDismiss: () => void }) {
  const [copied, setCopied] = useState(false);

  if (handover.kind === 'invited') {
    return (
      <Card className="border-emerald-300 bg-emerald-50">
        <CardBody className="space-y-3">
          <div>
            <p className="text-sm font-medium text-slate-900">
              Setup link emailed to {handover.email}
            </p>
            <p className="text-xs text-slate-600">
              They choose their own password from the link, so nobody else ever sees it. Ask them to
              check their spam folder if it has not arrived in a few minutes.
            </p>
          </div>
          <Button variant="ghost" size="sm" onClick={onDismiss}>
            Done
          </Button>
        </CardBody>
      </Card>
    );
  }

  return (
    <Card className="border-amber-300 bg-amber-50">
      <CardBody className="space-y-3">
        <div>
          <p className="text-sm font-medium text-slate-900">
            Temporary password for {handover.email}
          </p>
          <p className="text-xs text-slate-600">
            Email could not be sent, so hand this over directly. Shown once — the server never
            returns it again — and they will be asked to change it at first sign-in.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <code className="rounded border border-amber-300 bg-white px-3 py-2 font-mono text-sm">{handover.password}</code>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              void navigator.clipboard.writeText(handover.password).then(() => setCopied(true));
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

function AddUserForm({ onDone }: { onDone: (result: Handover | null) => void }) {
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
      onDone(handoverFrom(result));
    },
  });

  function toggleClass(code: string) {
    setClasses((current) =>
      current.includes(code) ? current.filter((c) => c !== code) : [...current, code],
    );
  }

  return (
    <Card>
      <CardHeader
        title="Add user"
        description="They are emailed a link to set their own password. If email is unavailable, a one-time password is shown instead."
      />
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
            <ClassPicker selected={classes} onToggle={toggleClass} />
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

function ClassPicker({
  selected,
  onToggle,
}: {
  selected: readonly string[];
  onToggle: (code: ClassCode) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2 pt-1">
      {CLASS_CODES.map((code) => (
        <label
          key={code}
          className="flex cursor-pointer items-center gap-1.5 rounded-md border border-slate-300 px-2.5 py-1.5 text-sm hover:bg-slate-50"
        >
          <input type="checkbox" checked={selected.includes(code)} onChange={() => onToggle(code)} />
          {classLabel(code)}
        </label>
      ))}
    </div>
  );
}

/** Only ever opened for a teacher: admin rows have no Edit button. */
function EditUserForm({ user, onDone }: { user: UserDto; onDone: () => void }) {
  const [name, setName] = useState(user.name);
  const [phone, setPhone] = useState(user.phone);
  const [role, setRole] = useState(user.role);
  const [classes, setClasses] = useState<ClassCode[]>(user.assignedClasses as ClassCode[]);

  const update = useMutation({
    mutationFn: () =>
      usersApi.update(user.id, {
        name,
        // optionalText drops a blank, so an existing number cannot be cleared here —
        // only replaced. Sending it unchanged is harmless.
        phone: phone.trim() === '' ? undefined : phone,
        role,
        assignedClasses: role === 'ADMIN' ? [] : classes,
      }),
    onSuccess: onDone,
  });

  function toggleClass(code: ClassCode) {
    setClasses((current) =>
      current.includes(code) ? current.filter((c) => c !== code) : [...current, code],
    );
  }

  return (
    <Card>
      <CardHeader
        title={`Edit ${user.name}`}
        description="Change the role to promote a teacher to admin, or adjust which classes they can reach. Passwords are not managed here — users reset their own from the sign-in page."
      />
      <CardBody className="space-y-4">
        {update.error && <ErrorBlock message={(update.error as Error).message} />}

        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Full name" required>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Email" hint="Email cannot be changed — add a new user instead.">
            <Input value={user.email} disabled />
          </Field>
          <Field label="Phone">
            <Input value={phone} onChange={(e) => setPhone(e.target.value)} />
          </Field>
        </div>

        <Field
          label="Role"
          required
          hint={
            role === 'ADMIN'
              ? 'Admins reach every class, so no class list is kept for them. This cannot be undone from the Users page.'
              : undefined
          }
        >
          <Select value={role} onChange={(e) => setRole(e.target.value as UserDto['role'])}>
            {USER_ROLES.map((value) => (
              <option key={value} value={value}>
                {value === 'ADMIN' ? 'Admin' : 'Teacher'}
              </option>
            ))}
          </Select>
        </Field>

        {role === 'TEACHER' && (
          <Field label="Assigned classes" required hint="A teacher can only mark attendance for these.">
            <ClassPicker selected={classes} onToggle={toggleClass} />
          </Field>
        )}

        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onDone}>
            Cancel
          </Button>
          <Button
            onClick={() => update.mutate()}
            disabled={update.isPending || !name || (role === 'TEACHER' && classes.length === 0)}
          >
            {update.isPending && <Spinner />}
            Save changes
          </Button>
        </div>
      </CardBody>
    </Card>
  );
}
