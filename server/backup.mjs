import { openDatabase } from "./db.mjs";
import { mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
const destination = resolve(
  process.argv[2] ||
    `data/backups/tgs-${new Date().toISOString().replace(/[:.]/g, "-")}.sqlite`,
);
mkdirSync(dirname(destination), { recursive: true });
const db = openDatabase();
try {
  db.prepare("VACUUM INTO ?").run(destination);
  console.log(`Consistent database backup saved to ${destination}`);
} finally {
  db.close();
}
