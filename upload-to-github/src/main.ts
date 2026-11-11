import { existsSync } from "node:fs";
import { configFromEnv, createApp } from "./app";
import { buildServer } from "./api/server";
import { redactSecrets } from "./security/sanitize";

if (existsSync(".env")) process.loadEnvFile(".env");

async function main() {
  const env = process.env;
  if (!env.APP_ENCRYPTION_KEY) {
    console.error("APP_ENCRYPTION_KEY is not set. Copy .env.example to .env and set it (openssl rand -base64 32).\nWithout a stable key, stored marketplace credentials could not be read after a restart.");
    process.exit(1);
  }
  const app = createApp(configFromEnv(env));

  // First run: create the owner account from the environment.
  if (app.auth.userCount() === 0) {
    if (env.ADMIN_EMAIL && env.ADMIN_PASSWORD) {
      app.auth.createUser(env.ADMIN_EMAIL, env.ADMIN_PASSWORD, "owner");
      console.log(`Created owner account ${env.ADMIN_EMAIL}`);
    } else {
      console.warn("No users exist yet. Set ADMIN_EMAIL and ADMIN_PASSWORD in .env and restart, or run: npm run user:create -- <email> owner");
    }
  }

  const server = await buildServer(app, { cookieSecure: env.COOKIE_SECURE === "true", logger: env.NODE_ENV === "production" });
  const port = Number(env.PORT ?? 4000);
  const host = env.HOST ?? "127.0.0.1";
  await server.listen({ port, host });
  app.start();
  console.log(`Resale Ops is running at http://${host === "0.0.0.0" ? "localhost" : host}:${port}`);

  const shutdown = async () => {
    await server.close();
    await app.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  console.error("Failed to start:", redactSecrets(String(error?.stack ?? error)));
  process.exit(1);
});
