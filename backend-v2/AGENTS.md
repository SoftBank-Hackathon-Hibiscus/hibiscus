# Hibiscus Backend Agent Instructions

## Backend Conventions

- Use Drizzle for database access.
- Environment variables must be aliased through `registerAs` config factories under `src/config/configs`.
- Application code should read config aliases such as `auth.jwt.accessSecret`, not raw env keys such as `JWT_ACCESS_SECRET`.
- Raw `process.env` access is allowed only inside config factories
- HTTP request DTOs must use `class-validator` and `class-transformer`.
- Keep the global `ValidationPipe` enabled with `transform`, `whitelist`, and `forbidNonWhitelisted`.
- Responses that need transformation must use response DTOs with class-transformer and Nest `SerializeOptions`.
- Keep `ClassSerializerInterceptor` registered globally.

## Auth

- Users authenticate through a GitHub App's OAuth user authorization flow.
- GitHub App user authorization must use authorization code flow with PKCE. Do not request OAuth App scopes.
- OAuth callback responses are JSON API responses, not redirects or server-rendered responses.
- Issue access and refresh tokens with `@nestjs/jwt`.
- Refresh tokens are JWTs; do not add server-side session management.
- Protect authenticated APIs with `JwtAuthGuard` and Bearer access tokens.


## File Layout

- `*.controller.ts`, `*.service.ts`, and `*.module.ts` stay directly under the feature folder.
- Other feature files must live in typed subfolders:
  - `dto/*.dto.ts`
  - `interfaces/*.interface.ts`
  - `types/*.type.ts`
  - `specs/*.spec.ts`
- Do not place DTOs, interfaces, types, or specs at the feature folder root.
- Do not add `entities/*.entity.ts`; API response contracts are DTOs.

## Type Safety

- Prefer DTO validation and explicit contracts over ad hoc runtime type checks.
- Minimize `typeof` and similar runtime checks.
- When runtime checks are unavoidable for external input or provider claims, keep them narrow and local.

## Verification

- After backend changes, run:
  - `npm run build`
  - `npm run lint`
  - relevant tests when behavior is changed
