import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { openDatabase } from "./db.ts";

const port = Number(process.env.PORT ?? 3008);
serve({ fetch: createApp({ db: openDatabase(process.env.DB_PATH ?? ":memory:") }).fetch, port, hostname: "127.0.0.1" });
console.log(`API de revisão de vídeo em http://127.0.0.1:${port}`);
