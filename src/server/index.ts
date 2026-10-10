/** Production entrypoint: Neon-backed API gateway. */
import { serve } from "@hono/node-server";
import { createAuth } from "../auth";
import { loadEnv } from "../config/env";
import { createDb } from "../db/client";
import { buildApp } from "./app";

const env = loadEnv();
const db = createDb();
const auth = createAuth(db);
const app = buildApp({ auth, db, allowedOrigins: env.ALLOWED_ORIGINS.split(",").map((o) => o.trim()).filter(Boolean) });

const port = Number(process.env.PORT ?? 3000);
serve({ fetch: app.fetch, port }, () => {
  console.log(`sf-assistant gateway listening on :${port}`);
});
