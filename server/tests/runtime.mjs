// Isolated browser-test server. Never imported by the production entrypoint.
import { openDatabase } from "../db.mjs";
import { createApp } from "../app.mjs";
import { configFromEnv } from "../config.mjs";
import { hashPassword } from "../security.mjs";
const db = openDatabase(":memory:");
db.prepare(
  "INSERT INTO users(id,email,handle,name,password_hash,verified,role) VALUES(?,?,?,?,?,1,'admin')",
).run(
  "test-admin",
  "admin@example.com",
  "test_admin",
  "Test Admin",
  await hashPassword("Test administrator password 42!"),
);
db.prepare(
  "INSERT INTO users(id,email,handle,name,password_hash,verified) VALUES(?,?,?,?,?,1)",
).run(
  "test-plus",
  "plus@example.com",
  "test_plus",
  "Plus Player",
  await hashPassword("Test Plus password 42!"),
);
db.prepare(
  "INSERT INTO subscriptions(id,user_id,provider,status,period_end) VALUES('test-sub','test-plus','stripe','active',?)",
).run(Math.floor(Date.now() / 1000) + 86400);
const config = configFromEnv({ PUBLIC_URL: "http://127.0.0.1:5174" });
const app = createApp({ db, config, disableRateLimits: true });
const server = app.listen(3002, "127.0.0.1");
process.on("SIGTERM", () =>
  server.close(() => {
    db.close();
    process.exit(0);
  }),
);
