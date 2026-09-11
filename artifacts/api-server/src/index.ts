import { createServer } from "node:http";
import { initDatabase, releaseStaleClaims, takePollingLock } from "./db";
import { startBot } from "./bot";

async function main() {
  if (!process.env.BOT_TOKEN) throw new Error("BOT_TOKEN is required");
  if (!process.env.OWNER_ID) throw new Error("OWNER_ID is required");
  await initDatabase();
  await releaseStaleClaims();
  const lock = await takePollingLock();
  const port = Number(process.env.PORT ?? 8080);
  const healthServer = createServer((request, response) => {
    if (request.url === "/api/healthz" || request.url === "/healthz") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, service: "free-coupon-hub" }));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  healthServer.listen(port, "0.0.0.0");
  const shutdown = async () => {
    healthServer.close();
    await lock.query("SELECT pg_advisory_unlock(871426031)").catch(() => undefined);
    lock.release();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  await startBot();
}

main().catch((error) => {
  console.error("Free Coupon Hub failed to start", error);
  process.exit(1);
});