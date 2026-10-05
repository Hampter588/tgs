import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

export function openDatabase(
  filename = process.env.DATABASE_PATH || "data/tgs.sqlite",
) {
  if (filename !== ":memory:")
    mkdirSync(dirname(resolve(filename)), { recursive: true });
  const db = new DatabaseSync(filename);
  db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS migrations(version INTEGER PRIMARY KEY, applied_at TEXT DEFAULT CURRENT_TIMESTAMP);
  `);
  if (!db.prepare("SELECT 1 FROM migrations WHERE version=1").get()) {
    db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE users(id TEXT PRIMARY KEY,email TEXT UNIQUE COLLATE NOCASE NOT NULL,handle TEXT UNIQUE COLLATE NOCASE NOT NULL,name TEXT NOT NULL,password_hash TEXT NOT NULL,bio TEXT NOT NULL DEFAULT '',format TEXT NOT NULL DEFAULT 'Commander',theme TEXT NOT NULL DEFAULT 'purple',role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('user','admin')),banned INTEGER NOT NULL DEFAULT 0,ban_reason TEXT,verified INTEGER NOT NULL DEFAULT 0,stripe_customer TEXT UNIQUE,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE sessions(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,expires_at INTEGER NOT NULL);
      CREATE TABLE email_tokens(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,kind TEXT NOT NULL CHECK(kind IN ('verify','reset')),expires_at INTEGER NOT NULL);
      CREATE TABLE posts(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,text TEXT NOT NULL,format TEXT NOT NULL,type TEXT NOT NULL,deck_id TEXT,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,deleted_at TEXT);
      CREATE TABLE comments(id TEXT PRIMARY KEY,post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,text TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,deleted_at TEXT);
      CREATE TABLE likes(user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,PRIMARY KEY(user_id,post_id));
      CREATE TABLE bookmarks(user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,PRIMARY KEY(user_id,post_id));
      CREATE TABLE blocks(user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,blocked_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,PRIMARY KEY(user_id,blocked_id));
      CREATE TABLE groups(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,name TEXT NOT NULL,description TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE memberships(group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,PRIMARY KEY(group_id,user_id));
      CREATE TABLE group_messages(id TEXT PRIMARY KEY,group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,text TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE games(id TEXT PRIMARY KEY,host_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,title TEXT NOT NULL,format TEXT NOT NULL,location TEXT NOT NULL,date TEXT NOT NULL,time TEXT NOT NULL,timezone TEXT NOT NULL,capacity INTEGER NOT NULL CHECK(capacity BETWEEN 2 AND 64),description TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE attendees(game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,PRIMARY KEY(game_id,user_id));
      CREATE TABLE decks(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,name TEXT NOT NULL,format TEXT NOT NULL,commander TEXT NOT NULL,list TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE deck_versions(id TEXT PRIMARY KEY,deck_id TEXT NOT NULL REFERENCES decks(id) ON DELETE CASCADE,name TEXT NOT NULL,list TEXT NOT NULL,note TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE game_logs(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,deck_id TEXT REFERENCES decks(id) ON DELETE SET NULL,format TEXT NOT NULL,result TEXT NOT NULL CHECK(result IN ('win','loss','draw')),notes TEXT NOT NULL,played_at TEXT NOT NULL);
      CREATE TABLE reports(id TEXT PRIMARY KEY,reporter_id TEXT REFERENCES users(id) ON DELETE SET NULL,target_type TEXT NOT NULL CHECK(target_type IN ('post','comment','user')),target_id TEXT NOT NULL,reason TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'open',created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE subscriptions(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,provider TEXT NOT NULL,status TEXT NOT NULL,price_id TEXT,period_end INTEGER NOT NULL DEFAULT 0,cancel_at_period_end INTEGER NOT NULL DEFAULT 0,updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE billing_events(id TEXT PRIMARY KEY,processed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE audit_logs(id INTEGER PRIMARY KEY AUTOINCREMENT,actor_id TEXT,action TEXT NOT NULL,target_id TEXT NOT NULL,reason TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
      CREATE INDEX posts_feed ON posts(created_at DESC);
      CREATE INDEX comments_post ON comments(post_id,created_at);
      CREATE INDEX sessions_user ON sessions(user_id);
      CREATE INDEX subscriptions_user ON subscriptions(user_id);
      INSERT INTO migrations(version) VALUES(1); COMMIT;`);
  }
  if (!db.prepare("SELECT 1 FROM migrations WHERE version=2").get()) {
    db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE checkout_sessions(user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,idempotency_key TEXT NOT NULL,session_id TEXT,url TEXT,expires_at INTEGER NOT NULL,interval TEXT NOT NULL);
      INSERT INTO migrations(version) VALUES(2); COMMIT;`);
  }
  return db;
}
export function transaction(db, fn) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
