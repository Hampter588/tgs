import { openDatabase } from "./db.mjs";
import { createApp } from "./app.mjs";
import { configFromEnv } from "./config.mjs";
const db = openDatabase();
const app = createApp({ db, config: configFromEnv() });
const server = app.listen(
  Number(process.env.PORT || 3001),
  process.env.HOST || "127.0.0.1",
  () => console.log(`TGS server listening on port ${process.env.PORT || 3001}`),
);
function shutdown() {
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
