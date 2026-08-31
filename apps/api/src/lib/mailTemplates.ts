/**
 * The bodies of every email the app sends.
 *
 * Kept out of the auth service so that changing wording does not mean touching token
 * logic, and so both templates share one escaping helper rather than each growing their
 * own.
 */

export interface MailBody {
  subject: string;
  text: string;
  html: string;
}

/** Minimal escaping for the values interpolated into the HTML body. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Renders "45 minutes", "1 hour", "3 days" — whichever reads naturally for the TTL. */
function describeValidity(minutes: number): string {
  if (minutes % (60 * 24) === 0) {
    const days = minutes / (60 * 24);
    return `${days} day${days === 1 ? '' : 's'}`;
  }
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return `${hours} hour${hours === 1 ? '' : 's'}`;
  }
  return `${minutes} minutes`;
}

/** Sent when someone asks to reset a password they have forgotten. */
export function passwordResetEmail(name: string, link: string, ttlMinutes: number): MailBody {
  const validity = describeValidity(ttlMinutes);

  return {
    subject: 'Reset your RNTPS Admin password',
    text: [
      `Hello ${name},`,
      '',
      'Use this link to set a new password:',
      link,
      '',
      `The link expires in ${validity} and can be used once.`,
      'If you did not ask for this, you can ignore this email — nothing has changed.',
    ].join('\n'),
    html: [
      `<p>Hello ${escapeHtml(name)},</p>`,
      '<p>Use this link to set a new password:</p>',
      `<p><a href="${escapeHtml(link)}">Set a new password</a></p>`,
      `<p style="color:#475569;font-size:14px">The link expires in ${validity} and can be used once. `,
      'If you did not ask for this, you can ignore this email — nothing has changed.</p>',
    ].join(''),
  };
}

/**
 * Sent when an admin creates an account, or resets one on the holder's behalf.
 *
 * Deliberately never contains a password: the recipient chooses their own through the
 * link, so no readable credential exists to be forwarded, overheard or screenshotted.
 */
export function invitationEmail(name: string, link: string, ttlMinutes: number): MailBody {
  const validity = describeValidity(ttlMinutes);

  return {
    subject: 'Set up your RNTPS Admin account',
    text: [
      `Hello ${name},`,
      '',
      'An account has been created for you on RNTPS Admin.',
      'Use this link to choose your password and sign in:',
      link,
      '',
      `The link expires in ${validity} and can be used once.`,
      'Nobody else can see the password you choose — not even an administrator.',
    ].join('\n'),
    html: [
      `<p>Hello ${escapeHtml(name)},</p>`,
      '<p>An account has been created for you on RNTPS Admin. Use this link to choose your password and sign in:</p>',
      `<p><a href="${escapeHtml(link)}">Set your password</a></p>`,
      `<p style="color:#475569;font-size:14px">The link expires in ${validity} and can be used once. `,
      'Nobody else can see the password you choose — not even an administrator.</p>',
    ].join(''),
  };
}
