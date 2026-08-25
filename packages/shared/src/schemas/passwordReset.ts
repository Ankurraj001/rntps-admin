import { z } from 'zod';
import { emailSchema, passwordSchema } from './auth.js';

export const forgotPasswordSchema = z.object({
  email: emailSchema,
});

export const resetPasswordWithTokenSchema = z.object({
  token: z.string().trim().min(20, 'That reset link is not valid').max(200),
  newPassword: passwordSchema,
});

export type ForgotPasswordPayload = z.output<typeof forgotPasswordSchema>;
export type ResetPasswordWithTokenPayload = z.output<typeof resetPasswordWithTokenSchema>;
