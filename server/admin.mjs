import { openDatabase } from "./db.mjs";
import { hashPassword } from "./security.mjs";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
const db = openDatabase();
const rl = createInterface({ input: process.stdin, output: process.stdout });
try {
  const email = (
    process.env.ADMIN_EMAIL || (await rl.question("Admin email: "))
  )
    .trim()
    .toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    throw new Error("A valid email is required.");
  const existing = db.prepare("SELECT id FROM users WHERE email=?").get(email);
  if (existing) {
    db.prepare(
      "UPDATE users SET role='admin',verified=1,banned=0 WHERE id=?",
    ).run(existing.id);
    console.log(
      "Existing account promoted to administrator. Password unchanged.",
    );
  } else {
    if (!process.env.ADMIN_PASSWORD || process.env.ADMIN_PASSWORD.length < 12)
      throw new Error(
        "Set ADMIN_PASSWORD (12+ characters) in the environment. No default password is provided.",
      );
    db.prepare(
      "INSERT INTO users(id,email,handle,name,password_hash,role,verified) VALUES(?,?,?,?,?,'admin',1)",
    ).run(
      randomUUID(),
      email,
      process.env.ADMIN_HANDLE || "tgs_admin",
      "TGS Administrator",
      await hashPassword(process.env.ADMIN_PASSWORD),
    );
    console.log(
      "Administrator created. Remove ADMIN_PASSWORD from your environment now.",
    );
  }
} finally {
  rl.close();
  db.close();
}
