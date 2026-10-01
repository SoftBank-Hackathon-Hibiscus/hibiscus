/** HTTP API (Hono). 입력은 zod 로 검사하고, 서비스 오류를 상태 코드로 바꾼다 */
import { Hono } from "hono";
import type { ZodType } from "zod";
import { ConflictError, NotFoundError, ValidationError } from "../errors.js";
import { RevisionMismatchError, RevisionUnavailableError } from "../infrastructure/git.js";
import { ApprovalRefusedError } from "../pipeline/approval/provider.js";
import { ApproveInputSchema, CreateAppInputSchema, CreateRunInputSchema } from "../pipeline/models.js";
import type { PipelineService } from "../pipeline/service.js";

class BadRequest extends Error {
  constructor(
    message: string,
    readonly issues?: unknown,
  ) {
    super(message);
  }
}

async function parseBody<T>(req: Request, schema: ZodType<T>): Promise<T> {
  let data: unknown;
  try {
    data = await req.json();
  } catch {
    throw new BadRequest("요청 본문이 JSON 이 아님");
  }
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first?.path.join(".") || "(최상위)";
    throw new BadRequest(`입력 형식 오류 ${where}: ${first?.message ?? "알 수 없음"}`, parsed.error.issues);
  }
  return parsed.data;
}

export function createApp(service: PipelineService): Hono {
  const app = new Hono();

  app.get("/healthz", (c) => c.json({ ok: true }));

  app.post("/apps", async (c) => {
    const input = await parseBody(c.req.raw, CreateAppInputSchema);
    return c.json(await service.createApp(input), 201);
  });

  app.get("/apps", async (c) => c.json(await service.listApps()));

  app.get("/apps/:id", async (c) => c.json(await service.getApp(c.req.param("id"))));

  app.post("/apps/:id/runs", async (c) => {
    const input = await parseBody(c.req.raw, CreateRunInputSchema);
    const run = await service.startRun(c.req.param("id"), input);
    return c.json(run, 202);
  });

  app.get("/runs/:id", async (c) => c.json(await service.getRunView(c.req.param("id"))));

  app.post("/runs/:id/approve", async (c) => {
    const input = await parseBody(c.req.raw, ApproveInputSchema);
    const run = await service.approve(c.req.param("id"), input);
    return c.json(run, 202);
  });

  app.notFound((c) => c.json({ error: "경로 없음" }, 404));

  app.onError((e, c) => {
    if (e instanceof BadRequest) return c.json({ error: e.message, ...(e.issues ? { issues: e.issues } : {}) }, 400);
    if (e instanceof ValidationError || e instanceof RevisionMismatchError || e instanceof RevisionUnavailableError) {
      return c.json({ error: e.message }, 400);
    }
    if (e instanceof ApprovalRefusedError) return c.json({ error: e.message }, 403);
    if (e instanceof NotFoundError) return c.json({ error: e.message }, 404);
    if (e instanceof ConflictError) return c.json({ error: e.message }, 409);
    console.error(e);
    return c.json({ error: "내부 오류" }, 500);
  });

  return app;
}
