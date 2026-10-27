import "reflect-metadata";
import { createContext } from "@vp/server";
import { createApp } from "./app";

async function main() {
  const ctx = await createContext({ migrate: true });
  if (!ctx.cfg.appPassword && ctx.cfg.env.ALLOW_NO_PASSWORD !== "1") {
    console.error("APP_PASSWORD is not set. Set it in .env (or ALLOW_NO_PASSWORD=1 for throwaway local runs). Refusing to start.");
    process.exit(1);
  }
  const app = await createApp(ctx);
  const host = ctx.cfg.env.BIND_HOST ?? "127.0.0.1";
  const port = Number(ctx.cfg.env.API_PORT ?? 4000);
  await app.listen(port, host);
  console.log(`api listening on http://${host}:${port} (providers: ${ctx.cfg.mockProviders ? "MOCK" : "real"})`);

  const shutdown = async () => {
    await app.close();
    await ctx.ds.destroy();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => {
  console.error("fatal:", e);
  process.exit(1);
});
