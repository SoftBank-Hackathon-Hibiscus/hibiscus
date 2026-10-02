import { registerAs } from '@nestjs/config';
import { z } from 'zod';
import { hkdfSync } from 'node:crypto';

export const authEnvironmentSchema = z
  .object({
    GITHUB_APP_CLIENT_ID: z.string().trim().min(1),
    GITHUB_APP_CLIENT_SECRET: z.string().trim().min(1),
    GITHUB_APP_SLUG: z
      .string()
      .regex(/^[a-z0-9-]*$/)
      .default(''),
    GITHUB_WEBHOOK_SECRET: z
      .union([z.literal(''), z.string().min(32)])
      .default(''),
    GITHUB_TOKEN_ENCRYPTION_KEY: z
      .union([z.literal(''), z.string().regex(/^[a-f0-9]{64}$/i)])
      .default(''),
    GITHUB_APP_CALLBACK_URL: z
      .url()
      .default('http://localhost:8080/auth/github/callback'),
    ALLOWED_GITHUB_IDS: z
      .string()
      .transform((value) =>
        value
          .split(',')
          .map((id) => id.trim())
          .filter(Boolean),
      )
      .pipe(
        z
          .array(z.string().regex(/^[1-9]\d*$/))
          .min(1, 'At least one allowed GitHub user ID is required'),
      )
      .transform((ids) => [...new Set(ids)]),
    JWT_ACCESS_SECRET: z.string().min(32),
    JWT_REFRESH_SECRET: z.string().min(32),
    JWT_ACCESS_TTL_SECONDS: z.coerce
      .number()
      .int()
      .min(60)
      .max(3600)
      .default(900),
    JWT_REFRESH_TTL_SECONDS: z.coerce
      .number()
      .int()
      .min(3600)
      .max(2592000)
      .default(604800),
  })
  .refine((value) => value.JWT_ACCESS_SECRET !== value.JWT_REFRESH_SECRET, {
    message: 'Access and refresh signing keys must differ',
  });

export const authConfig = registerAs('auth', () => {
  const env = authEnvironmentSchema.parse(process.env);
  return {
    githubApp: {
      clientId: env.GITHUB_APP_CLIENT_ID,
      clientSecret: env.GITHUB_APP_CLIENT_SECRET,
      callbackUrl: env.GITHUB_APP_CALLBACK_URL,
      slug: env.GITHUB_APP_SLUG,
      webhookSecret: env.GITHUB_WEBHOOK_SECRET,
      tokenEncryptionKey:
        env.GITHUB_TOKEN_ENCRYPTION_KEY ||
        Buffer.from(
          hkdfSync(
            'sha256',
            env.JWT_REFRESH_SECRET,
            'hibiscus',
            'github-credential-encryption',
            32,
          ),
        ).toString('hex'),
      allowedUserIds: env.ALLOWED_GITHUB_IDS,
    },
    jwt: {
      accessSecret: env.JWT_ACCESS_SECRET,
      refreshSecret: env.JWT_REFRESH_SECRET,
      accessTtlSeconds: env.JWT_ACCESS_TTL_SECONDS,
      refreshTtlSeconds: env.JWT_REFRESH_TTL_SECONDS,
      issuer: 'hibiscus-backend',
    },
  };
});
export type AuthConfig = { auth: ReturnType<typeof authConfig> };
