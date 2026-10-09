import type { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import type { Context } from "hono";
import { DomainError, VideoReviewService } from "./service.ts";

export type AppOptions = { db: DatabaseSync; clock?: () => Date };

async function readBody(c: Context): Promise<Record<string, unknown>> {
  const body = await c.req.json().catch(() => null);
  return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

export function createApp(options: AppOptions) {
  const service = new VideoReviewService(options.db, options.clock);
  const app = new Hono();

  app.onError((error, c) => {
    if (error instanceof DomainError) {
      return c.json({ error: error.code, message: error.message, ...(error.details as object | undefined) }, error.status);
    }
    throw error;
  });

  const versionNumber = (c: Context): number => {
    const n = Number(c.req.param("n"));
    if (!Number.isInteger(n) || n < 1) throw new DomainError(400, "invalid", "número de versão inválido");
    return n;
  };

  app.get("/health", (c) => c.json({ ok: true }));

  app.post("/campaigns", async (c) => c.json(service.createCampaign(await readBody(c)), 201));
  app.get("/campaigns/:id", (c) => c.json(service.getCampaign(c.req.param("id"))));

  app.post("/deliveries", async (c) => c.json(service.createDelivery(await readBody(c)), 201));
  app.get("/deliveries/:id", (c) => c.json(service.getDelivery(c.req.param("id"))));
  app.post("/deliveries/:id/approve", (c) => c.json(service.approveDelivery(c.req.param("id"))));

  app.post("/deliveries/:id/pieces/:piece/versions", async (c) =>
    c.json(service.submitVersion(c.req.param("id"), c.req.param("piece"), await readBody(c)), 201),
  );
  app.get("/deliveries/:id/pieces/:piece/versions/:n", (c) =>
    c.json(service.getVersion(c.req.param("id"), c.req.param("piece"), versionNumber(c))),
  );
  app.post("/deliveries/:id/pieces/:piece/versions/:n/approve", (c) =>
    c.json(service.decideVersion(c.req.param("id"), c.req.param("piece"), versionNumber(c), "approved")),
  );
  app.post("/deliveries/:id/pieces/:piece/versions/:n/request-changes", (c) =>
    c.json(service.decideVersion(c.req.param("id"), c.req.param("piece"), versionNumber(c), "changes_requested")),
  );
  app.post("/deliveries/:id/pieces/:piece/versions/:n/comments", async (c) =>
    c.json(service.addComment(c.req.param("id"), c.req.param("piece"), versionNumber(c), await readBody(c)), 201),
  );

  return app;
}
