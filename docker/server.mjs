import { startProdServer } from "vinext/server/prod-server";

const rawPort = Number.parseInt(process.env.PORT ?? "3000", 10);
const port = Number.isFinite(rawPort) ? rawPort : 3000;

await startProdServer({
  host: "0.0.0.0",
  port,
  outDir: "dist",
  purpose: "Docker",
});
