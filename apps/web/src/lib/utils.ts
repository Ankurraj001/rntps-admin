import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/** Renders a stored 91XXXXXXXXXX number as the 10 digits people actually recognise. */
export function displayPhone(stored: string): string {
  const local = stored.startsWith('91') ? stored.slice(2) : stored;
  return local.replace(/(\d{5})(\d{5})/, '$1 $2');
}

export function formatDate(dateKey: string): string {
  if (!dateKey) return '—';
  const [y, m, d] = dateKey.split('-');
  if (!y || !m || !d) return dateKey;
  return `${d}/${m}/${y}`;
}

/** Age in whole years, used on the student profile. */
export function ageFrom(dateKey: string): string {
  const [y, m, d] = dateKey.split('-').map(Number);
  if (!y || !m || !d) return '—';
  const today = new Date();
  let age = today.getFullYear() - y;
  const hadBirthday = today.getMonth() + 1 > m || (today.getMonth() + 1 === m && today.getDate() >= d);
  if (!hadBirthday) age -= 1;
  return `${age} yrs`;
}
