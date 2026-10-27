import "reflect-metadata";
import { createContext, startWorkers } from "@vp/server";

async function main() {
  const ctx = await createContext({ migrate: true });
  const { close } = startWorkers(ctx);
  console.log(`worker ready (providers: ${ctx.cfg.mockProviders ? "MOCK" : "real"})`);

  const shutdown = async () => {
    await close();
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
