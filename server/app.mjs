import express from "express";
import cors from "cors";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import { rateLimit } from "express-rate-limit";
import { z, ZodError } from "zod";
import Stripe from "stripe";
import nodemailer from "nodemailer";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { hashPassword, verifyPassword, token, hashToken } from "./security.mjs";
import { transaction } from "./db.mjs";
import {
  isPlus,
  handleBillingEvent,
  reconcileSubscription,
} from "./billing.mjs";
import { serial } from "./locks.mjs";
import { reconcileStore } from "./revenuecat.mjs";

const FORMATS = [
  "Commander",
  "Standard",
  "Modern",
  "Pioneer",
  "Legacy",
  "Vintage",
  "Pauper",
  "Limited",
  "Brawl",
  "Historic",
  "Timeless",
  "Explorer",
  "Alchemy",
  "Oathbreaker",
  "Premodern",
  "Canadian Highlander",
  "Other",
];
const format = z.enum(FORMATS);
const text = (max, min = 1) => z.string().trim().min(min).max(max);
const password = z.string().min(12).max(128);
const email = z
  .string()
  .email()
  .max(254)
  .transform((x) => x.toLowerCase());
const handle = z
  .string()
  .regex(/^[a-zA-Z0-9_]{3,30}$/)
  .transform((x) => x.toLowerCase());
const deckSchema = z
  .object({
    name: text(100),
    format,
    commander: text(120, 0).default(""),
    list: text(30000),
    note: text(1000, 0).default(""),
  })
  .strict();
const fail = (status, message) => {
  throw Object.assign(new Error(message), { status, expose: true });
};
const now = () => Math.floor(Date.now() / 1000);
export function createApp({
  db,
  config,
  stripeClient,
  sendMail,
  disableRateLimits = false,
  storeFetch = fetch,
}) {
  const app = express();
  const stripe =
    stripeClient ||
    (config.stripeSecret ? new Stripe(config.stripeSecret) : null);
  const transport = config.smtp
    ? nodemailer.createTransport(config.smtp)
    : null;
  const mail =
    sendMail ||
    (async (message) => {
      if (transport)
        await transport.sendMail({ from: config.mailFrom, ...message });
      else
        console.log("Email not sent: configure SMTP to enable account emails.");
    });
  const prices = [config.monthlyPrice, config.yearlyPrice].filter(Boolean);
  const billingReady = Boolean(
    stripe && config.webhookSecret && prices.length === 2,
  );
  app.disable("x-powered-by");
  app.set("trust proxy", config.trustProxy);
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", "data:"],
          connectSrc: ["'self'"],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
        },
      },
      strictTransportSecurity: config.production ? undefined : false,
    }),
  );
  app.use(
    cors({
      origin(origin, callback) {
        if (!origin || origin === "null" || config.origins.includes(origin))
          callback(null, true);
        else
          callback(
            Object.assign(new Error("Origin not allowed."), { status: 403 }),
          );
      },
      credentials: true,
    }),
  );
  if (!disableRateLimits)
    app.use(
      "/api",
      rateLimit({
        windowMs: 60000,
        limit: 240,
        standardHeaders: "draft-8",
        legacyHeaders: false,
      }),
    );
  app.get("/api/health", (_, res) => {
    db.prepare("SELECT 1").get();
    res.json({ status: "ok" });
  });
  app.post(
    "/api/billing/webhook",
    express.raw({ type: "application/json", limit: "1mb" }),
    async (req, res) => {
      if (!billingReady)
        return res.status(503).json({ error: "Billing is not configured." });
      let event;
      try {
        event = stripe.webhooks.constructEvent(
          req.body,
          req.get("stripe-signature"),
          config.webhookSecret,
        );
      } catch {
        return res.status(400).json({ error: "Invalid webhook signature." });
      }
      await handleBillingEvent(db, stripe, event, prices);
      res.json({ received: true });
    },
  );
  app.use(express.json({ limit: "128kb" }));
  app.use(cookieParser());
  app.post("/api/billing/store-webhook", async (req, res) => {
    if (!config.rcSecret || !config.rcWebhook)
      return res
        .status(503)
        .json({ error: "Store billing is not configured." });
    const given = Buffer.from(req.get("Authorization") || ""),
      expected = Buffer.from(config.rcWebhook);
    if (given.length !== expected.length || !timingSafeEqual(given, expected))
      return res.status(401).json({ error: "Invalid webhook authorization." });
    const event = z
      .object({
        id: text(200),
        app_user_id: z.string().optional(),
        aliases: z.array(z.string()).optional(),
        transferred_from: z.array(z.string()).optional(),
        transferred_to: z.array(z.string()).optional(),
      })
      .passthrough()
      .parse(req.body?.event);
    if (
      db
        .prepare("SELECT 1 FROM billing_events WHERE id=?")
        .get(`rc:${event.id}`)
    )
      return res.json({ received: true });
    const ids = [
      ...new Set(
        [
          event.app_user_id,
          ...(event.aliases || []),
          ...(event.transferred_from || []),
          ...(event.transferred_to || []),
        ].filter(Boolean),
      ),
    ].slice(0, 100);
    for (const id of ids) await reconcileStore(db, config, id, storeFetch);
    db.prepare("INSERT OR IGNORE INTO billing_events(id) VALUES(?)").run(
      `rc:${event.id}`,
    );
    res.json({ received: true });
  });
  app.use("/api", (req, res, next) => {
    res.set("Cache-Control", "no-store");
    if (
      !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
      req.get("X-TGS-Client") !== "1"
    )
      return res
        .status(403)
        .json({ error: "Missing request protection header." });
    const bearer = req.get("authorization")?.match(/^Bearer (.+)$/)?.[1];
    // Native file/webview origins may use an explicit bearer token, never ambient cookies.
    const cookieAllowed = req.get("origin")
      ? config.origins.includes(req.get("origin"))
      : ["GET", "HEAD"].includes(req.method);
    const sessionToken =
      bearer || (cookieAllowed ? req.cookies.tgs_session : null);
    if (sessionToken) {
      const row = db
        .prepare(
          "SELECT u.*,s.token_hash FROM users u JOIN sessions s ON s.user_id=u.id WHERE s.token_hash=? AND s.expires_at>?",
        )
        .get(hashToken(sessionToken), now());
      if (row && !row.banned) {
        req.user = row;
        req.sessionHash = row.token_hash;
      } else if (row?.banned) req.banned = true;
    }
    next();
  });
  const requireAuth = (req, _, next) => {
    if (!req.user)
      fail(
        req.banned ? 403 : 401,
        req.banned ? "This account has been banned." : "Sign in to continue.",
      );
    next();
  };
  const requireWrite = (req, _, next) => {
    if (config.requireVerification && !req.user.verified)
      fail(403, "Verify your email before posting or joining games.");
    next();
  };
  const admin = (req, _, next) => {
    if (req.user.role !== "admin") fail(403, "Administrator access required.");
    next();
  };
  const plus = (req, _, next) => {
    if (!isPlus(db, req.user.id))
      fail(402, "TGS Plus is required for this feature.");
    next();
  };
  const publicUser = (u) => ({
    id: u.id,
    name: u.name,
    handle: u.handle,
    bio: u.bio,
    format: u.format,
    theme: isPlus(db, u.id) ? u.theme : "purple",
  });
  const ownUser = (u) => ({
    ...publicUser(u),
    email: u.email,
    role: u.role,
    verified: Boolean(u.verified),
    plus: isPlus(db, u.id),
  });
  function session(res, user, req) {
    const raw = token();
    db.prepare("DELETE FROM sessions WHERE expires_at<=?").run(now());
    db.prepare(
      "INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)",
    ).run(hashToken(raw), user.id, now() + 30 * 86400);
    if (config.origins.includes(req.get("origin")))
      res.cookie("tgs_session", raw, {
        httpOnly: true,
        secure: config.production,
        sameSite: "lax",
        path: "/api",
        maxAge: 30 * 86400 * 1000,
      });
    return { user: ownUser(user), token: raw };
  }
  async function emailToken(user, kind) {
    const raw = token();
    db.prepare("DELETE FROM email_tokens WHERE user_id=? AND kind=?").run(
      user.id,
      kind,
    );
    db.prepare(
      "INSERT INTO email_tokens(token_hash,user_id,kind,expires_at) VALUES(?,?,?,?)",
    ).run(
      hashToken(raw),
      user.id,
      kind,
      now() + (kind === "reset" ? 3600 : 86400),
    );
    await mail({
      to: user.email,
      subject:
        kind === "reset" ? "Reset your TGS password" : "Verify your TGS email",
      text: `${kind === "reset" ? "Reset your password" : "Verify your email"}: ${config.publicUrl}/?${kind}=${raw}\nIf you did not request this, ignore this message.`,
    });
  }
  const authLimiter = disableRateLimits
    ? (_, __, next) => next()
    : rateLimit({
        windowMs: 15 * 60000,
        limit: 20,
        standardHeaders: "draft-8",
        legacyHeaders: false,
        message: { error: "Too many authentication attempts. Try again later." },
      });
  app.use("/api/auth", (req,res,next) => req.method === "POST" && req.path !== "/logout" ? authLimiter(req,res,next) : next());
  app.get("/api/config", (_, res) =>
    res.json({
      billingReady,
      requireVerification: config.requireVerification,
      formats: FORMATS,
      storeBilling: {
        ios: config.rcSecret && config.rcWebhook ? config.rcIosKey : null,
        android:
          config.rcSecret && config.rcWebhook ? config.rcAndroidKey : null,
      },
    }),
  );
  app.post("/api/auth/register", async (req, res) => {
    const data = z
      .object({ email, password, handle, name: text(60) })
      .strict()
      .parse(req.body);
    const id = randomUUID(),
      hash = await hashPassword(data.password);
    try {
      db.prepare(
        "INSERT INTO users(id,email,handle,name,password_hash,verified) VALUES(?,?,?,?,?,?)",
      ).run(
        id,
        data.email,
        data.handle,
        data.name,
        hash,
        Number(!config.requireVerification),
      );
    } catch (e) {
      if (e.code?.includes("CONSTRAINT") || e.message.includes("UNIQUE"))
        fail(409, "Email or handle is already in use.");
      throw e;
    }
    const user = db.prepare("SELECT * FROM users WHERE id=?").get(id);
    if (config.requireVerification) {
      try {
        await emailToken(user, "verify");
      } catch {
        return res
          .status(201)
          .json({
            ...session(res, user, req),
            message:
              "Account created. Email could not be sent; request a new verification email.",
          });
      }
    }
    res.status(201).json(session(res, user, req));
  });
  app.post("/api/auth/login", async (req, res) => {
    const data = z
      .object({ email, password: z.string().min(1).max(128) })
      .strict()
      .parse(req.body);
    const user = db
      .prepare("SELECT * FROM users WHERE email=?")
      .get(data.email);
    const valid = await verifyPassword(
      data.password,
      user?.password_hash || `${"0".repeat(32)}:${"0".repeat(128)}`,
    );
    if (!user || !valid) fail(401, "Invalid email or password.");
    if (user.banned) fail(403, "This account has been banned.");
    res.json(session(res, user, req));
  });
  app.get("/api/auth/me", requireAuth, (req, res) =>
    res.json(ownUser(req.user)),
  );
  app.post("/api/auth/logout", requireAuth, (req, res) => {
    db.prepare("DELETE FROM sessions WHERE token_hash=?").run(req.sessionHash);
    res.clearCookie("tgs_session", {
      path: "/api",
      httpOnly: true,
      sameSite: "lax",
      secure: config.production,
    });
    res.json({ ok: true });
  });
  app.post("/api/auth/forgot", async (req, res) => {
    const data = z.object({ email }).strict().parse(req.body);
    const user = db
      .prepare("SELECT * FROM users WHERE email=? AND banned=0")
      .get(data.email);
    if (user) {
      try {
        await emailToken(user, "reset");
      } catch {
        console.error("Password reset delivery failed.");
      }
    }
    res.json({
      message: "If that account exists, a reset email has been sent.",
    });
  });
  app.post("/api/auth/resend", requireAuth, async (req, res) => {
    if (!req.user.verified) await emailToken(req.user, "verify");
    res.json({ message: "Verification email requested." });
  });
  app.post("/api/auth/verify", (req, res) => {
    const data = z
      .object({ token: text(100) })
      .strict()
      .parse(req.body);
    const record = db
      .prepare(
        "SELECT * FROM email_tokens WHERE token_hash=? AND kind='verify' AND expires_at>?",
      )
      .get(hashToken(data.token), now());
    if (!record) fail(400, "Verification link is invalid or expired.");
    transaction(db, () => {
      db.prepare("UPDATE users SET verified=1 WHERE id=?").run(record.user_id);
      db.prepare("DELETE FROM email_tokens WHERE token_hash=?").run(
        record.token_hash,
      );
    });
    res.json({ ok: true });
  });
  app.post("/api/auth/reset", async (req, res) => {
    const data = z
      .object({ token: text(100), password })
      .strict()
      .parse(req.body);
    const hash = await hashPassword(data.password);
    transaction(db, () => {
      const record = db
        .prepare(
          "SELECT * FROM email_tokens WHERE token_hash=? AND kind='reset' AND expires_at>?",
        )
        .get(hashToken(data.token), now());
      if (!record) fail(400, "Reset link is invalid or expired.");
      db.prepare("UPDATE users SET password_hash=? WHERE id=?").run(
        hash,
        record.user_id,
      );
      db.prepare("DELETE FROM sessions WHERE user_id=?").run(record.user_id);
      db.prepare("DELETE FROM email_tokens WHERE user_id=?").run(
        record.user_id,
      );
    });
    res.json({ ok: true });
  });
  app.patch("/api/profile", requireAuth, (req, res) => {
    const data = z
      .object({
        name: text(60),
        handle,
        bio: text(300, 0),
        format,
        theme: z.enum(["purple", "green", "orange", "blue"]).default("purple"),
      })
      .strict()
      .parse(req.body);
    if (data.theme !== "purple" && !isPlus(db, req.user.id))
      fail(402, "Custom themes require TGS Plus.");
    try {
      db.prepare(
        "UPDATE users SET name=?,handle=?,bio=?,format=?,theme=? WHERE id=?",
      ).run(
        data.name,
        data.handle,
        data.bio,
        data.format,
        data.theme,
        req.user.id,
      );
    } catch (e) {
      if (e.message.includes("UNIQUE")) fail(409, "Handle already in use.");
      throw e;
    }
    res.json(
      ownUser(db.prepare("SELECT * FROM users WHERE id=?").get(req.user.id)),
    );
  });
  function accessiblePost(id, userId) {
    const post = db
      .prepare(
        `SELECT p.* FROM posts p JOIN users u ON u.id=p.user_id WHERE p.id=? AND p.deleted_at IS NULL AND u.banned=0 AND NOT EXISTS(SELECT 1 FROM blocks b WHERE (b.user_id=? AND b.blocked_id=p.user_id) OR (b.user_id=p.user_id AND b.blocked_id=?))`,
      )
      .get(id, userId, userId);
    if (!post) fail(404, "Post not found.");
    return post;
  }
  function postView(p, userId) {
    const author = db.prepare("SELECT * FROM users WHERE id=?").get(p.user_id);
    const deck = p.deck_id
      ? db
          .prepare("SELECT id,name,commander,list,format FROM decks WHERE id=?")
          .get(p.deck_id)
      : null;
    return {
      ...p,
      author: publicUser(author),
      deck,
      likes: db
        .prepare("SELECT COUNT(*) n FROM likes WHERE post_id=?")
        .get(p.id).n,
      liked: Boolean(
        db
          .prepare("SELECT 1 FROM likes WHERE post_id=? AND user_id=?")
          .get(p.id, userId),
      ),
      saved: Boolean(
        db
          .prepare("SELECT 1 FROM bookmarks WHERE post_id=? AND user_id=?")
          .get(p.id, userId),
      ),
      comments: db
        .prepare(
          "SELECT COUNT(*) n FROM comments c JOIN users u ON c.user_id=u.id WHERE post_id=? AND deleted_at IS NULL AND u.banned=0 AND NOT EXISTS(SELECT 1 FROM blocks b WHERE (b.user_id=? AND b.blocked_id=c.user_id) OR (b.user_id=c.user_id AND b.blocked_id=?))",
        )
        .get(p.id, userId, userId).n,
    };
  }
  app.get("/api/posts", requireAuth, (req, res) => {
    const page = z.coerce
      .number()
      .int()
      .min(0)
      .max(10000)
      .parse(req.query.page || 0);
    const selected =
      req.query.format && req.query.format !== "All formats"
        ? format.parse(req.query.format)
        : null;
    const search = String(req.query.search || "").slice(0, 200);
    const saved = req.query.saved === "true";
    const rows = db
      .prepare(
        `SELECT p.* FROM posts p JOIN users u ON u.id=p.user_id WHERE p.deleted_at IS NULL AND u.banned=0 AND (? IS NULL OR p.format=?) AND (instr(lower(p.text),lower(?))>0 OR instr(lower(u.name),lower(?))>0) AND (?=0 OR EXISTS(SELECT 1 FROM bookmarks s WHERE s.post_id=p.id AND s.user_id=?)) AND NOT EXISTS(SELECT 1 FROM blocks b WHERE (b.user_id=? AND b.blocked_id=p.user_id) OR (b.user_id=p.user_id AND b.blocked_id=?)) ORDER BY p.created_at DESC,p.rowid DESC LIMIT 31 OFFSET ?`,
      )
      .all(
        selected,
        selected,
        search,
        search,
        Number(saved),
        req.user.id,
        req.user.id,
        req.user.id,
        page * 30,
      );
    res.json({
      items: rows.slice(0, 30).map((p) => postView(p, req.user.id)),
      hasMore: rows.length > 30,
    });
  });
  app.post("/api/posts", requireAuth, requireWrite, (req, res) => {
    const data = z
      .object({
        text: text(4000),
        format,
        type: z.enum(["Discussion", "Game recap", "Deck showcase"]),
        deck_id: z.string().nullable().optional(),
      })
      .strict()
      .parse(req.body);
    if (
      data.deck_id &&
      !db
        .prepare("SELECT 1 FROM decks WHERE id=? AND user_id=?")
        .get(data.deck_id, req.user.id)
    )
      fail(404, "Deck not found.");
    const id = randomUUID();
    db.prepare(
      "INSERT INTO posts(id,user_id,text,format,type,deck_id) VALUES(?,?,?,?,?,?)",
    ).run(
      id,
      req.user.id,
      data.text,
      data.format,
      data.type,
      data.deck_id || null,
    );
    res
      .status(201)
      .json(postView(accessiblePost(id, req.user.id), req.user.id));
  });
  app.delete("/api/posts/:id", requireAuth, (req, res) => {
    const p = db
      .prepare("SELECT * FROM posts WHERE id=? AND deleted_at IS NULL")
      .get(req.params.id);
    if (!p) fail(404, "Post not found.");
    if (p.user_id !== req.user.id)
      fail(403, "Only the author can delete this post.");
    db.prepare("UPDATE posts SET deleted_at=CURRENT_TIMESTAMP WHERE id=?").run(
      p.id,
    );
    res.json({ ok: true });
  });
  for (const [route, table] of [
    ["like", "likes"],
    ["bookmark", "bookmarks"],
  ])
    app.put(
      `/api/posts/:id/${route}`,
      requireAuth,
      requireWrite,
      (req, res) => {
        accessiblePost(req.params.id, req.user.id);
        const { enabled } = z
          .object({ enabled: z.boolean() })
          .strict()
          .parse(req.body);
        if (enabled)
          db.prepare(
            `INSERT OR IGNORE INTO ${table}(user_id,post_id) VALUES(?,?)`,
          ).run(req.user.id, req.params.id);
        else
          db.prepare(`DELETE FROM ${table} WHERE user_id=? AND post_id=?`).run(
            req.user.id,
            req.params.id,
          );
        res.json({ ok: true });
      },
    );
  app.get("/api/posts/:id/comments", requireAuth, (req, res) => {
    accessiblePost(req.params.id, req.user.id);
    const rows = db
      .prepare(
        "SELECT c.* FROM comments c JOIN users u ON u.id=c.user_id WHERE c.post_id=? AND c.deleted_at IS NULL AND u.banned=0 AND NOT EXISTS(SELECT 1 FROM blocks b WHERE (b.user_id=? AND b.blocked_id=c.user_id) OR (b.user_id=c.user_id AND b.blocked_id=?)) ORDER BY c.created_at DESC,c.rowid DESC LIMIT 200",
      )
      .all(req.params.id, req.user.id, req.user.id);
    res.json(
      rows
        .reverse()
        .map((c) => ({
          ...c,
          author: publicUser(
            db.prepare("SELECT * FROM users WHERE id=?").get(c.user_id),
          ),
        })),
    );
  });
  app.post("/api/posts/:id/comments", requireAuth, requireWrite, (req, res) => {
    accessiblePost(req.params.id, req.user.id);
    const data = z
      .object({ text: text(2000) })
      .strict()
      .parse(req.body);
    db.prepare(
      "INSERT INTO comments(id,post_id,user_id,text) VALUES(?,?,?,?)",
    ).run(randomUUID(), req.params.id, req.user.id, data.text);
    res.status(201).json({ ok: true });
  });
  app.delete("/api/comments/:id", requireAuth, (req, res) => {
    const c = db
      .prepare("SELECT * FROM comments WHERE id=? AND deleted_at IS NULL")
      .get(req.params.id);
    if (!c) fail(404, "Comment not found.");
    if (c.user_id !== req.user.id)
      fail(403, "Only the author can delete this comment.");
    db.prepare(
      "UPDATE comments SET deleted_at=CURRENT_TIMESTAMP WHERE id=?",
    ).run(c.id);
    res.json({ ok: true });
  });
  app.get("/api/games", requireAuth, (req, res) => {
    res.json(
      db
        .prepare(
          "SELECT g.* FROM games g JOIN users u ON u.id=g.host_id WHERE u.banned=0 AND NOT EXISTS(SELECT 1 FROM blocks b WHERE (b.user_id=? AND b.blocked_id=g.host_id) OR (b.user_id=g.host_id AND b.blocked_id=?)) ORDER BY date,time LIMIT 200",
        )
        .all(req.user.id, req.user.id)
        .map((g) => ({
          ...g,
          attendees: db
            .prepare("SELECT COUNT(*) n FROM attendees WHERE game_id=?")
            .get(g.id).n,
          joined: Boolean(
            db
              .prepare("SELECT 1 FROM attendees WHERE game_id=? AND user_id=?")
              .get(g.id, req.user.id),
          ),
        })),
    );
  });
  app.post("/api/games", requireAuth, requireWrite, (req, res) => {
    const d = z
      .object({
        title: text(100),
        format,
        location: text(120),
        date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .refine(
            (v) =>
              !Number.isNaN(Date.parse(v)) &&
              new Date(v).toISOString().slice(0, 10) === v,
            "Invalid date",
          ),
        time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
        timezone: text(100).refine((v) => {
          try {
            new Intl.DateTimeFormat("en", { timeZone: v });
            return true;
          } catch {
            return false;
          }
        }, "Invalid timezone"),
        capacity: z.coerce.number().int().min(2).max(64),
        description: text(1000, 0),
      })
      .strict()
      .parse(req.body);
    const id = randomUUID();
    transaction(db, () => {
      db.prepare(
        "INSERT INTO games(id,host_id,title,format,location,date,time,timezone,capacity,description) VALUES(?,?,?,?,?,?,?,?,?,?)",
      ).run(
        id,
        req.user.id,
        d.title,
        d.format,
        d.location,
        d.date,
        d.time,
        d.timezone,
        d.capacity,
        d.description,
      );
      db.prepare("INSERT INTO attendees(game_id,user_id) VALUES(?,?)").run(
        id,
        req.user.id,
      );
    });
    res.status(201).json({ id });
  });
  app.put("/api/games/:id/rsvp", requireAuth, requireWrite, (req, res) => {
    const { joined } = z
      .object({ joined: z.boolean() })
      .strict()
      .parse(req.body);
    transaction(db, () => {
      const g = db
        .prepare(
          "SELECT g.* FROM games g JOIN users u ON u.id=g.host_id WHERE g.id=? AND u.banned=0 AND NOT EXISTS(SELECT 1 FROM blocks b WHERE (b.user_id=? AND b.blocked_id=g.host_id) OR (b.user_id=g.host_id AND b.blocked_id=?))",
        )
        .get(req.params.id, req.user.id, req.user.id);
      if (!g) fail(404, "Game not found.");
      const existing = db
        .prepare("SELECT 1 FROM attendees WHERE game_id=? AND user_id=?")
        .get(g.id, req.user.id);
      if (joined && !existing) {
        if (
          db
            .prepare("SELECT COUNT(*) n FROM attendees WHERE game_id=?")
            .get(g.id).n >= g.capacity
        )
          fail(409, "This table is full.");
        db.prepare("INSERT INTO attendees(game_id,user_id) VALUES(?,?)").run(
          g.id,
          req.user.id,
        );
      }
      if (!joined)
        db.prepare("DELETE FROM attendees WHERE game_id=? AND user_id=?").run(
          g.id,
          req.user.id,
        );
    });
    res.json({ ok: true });
  });
  app.delete("/api/games/:id", requireAuth, (req, res) => {
    const g = db.prepare("SELECT * FROM games WHERE id=?").get(req.params.id);
    if (!g) fail(404, "Game not found.");
    if (g.host_id !== req.user.id)
      fail(403, "Only the host can cancel this game.");
    db.prepare("DELETE FROM games WHERE id=?").run(g.id);
    res.json({ ok: true });
  });
  app.get("/api/groups", requireAuth, (req, res) =>
    res.json(
      db
        .prepare(
          "SELECT g.* FROM groups g JOIN users u ON u.id=g.owner_id WHERE u.banned=0 ORDER BY g.created_at DESC LIMIT 200",
        )
        .all()
        .map((g) => ({
          ...g,
          members: db
            .prepare("SELECT COUNT(*) n FROM memberships WHERE group_id=?")
            .get(g.id).n,
          joined: Boolean(
            db
              .prepare(
                "SELECT 1 FROM memberships WHERE group_id=? AND user_id=?",
              )
              .get(g.id, req.user.id),
          ),
        })),
    ),
  );
  app.post("/api/groups", requireAuth, requireWrite, (req, res) => {
    const d = z
      .object({ name: text(60), description: text(1000, 0) })
      .strict()
      .parse(req.body);
    const id = randomUUID();
    transaction(db, () => {
      db.prepare(
        "INSERT INTO groups(id,owner_id,name,description) VALUES(?,?,?,?)",
      ).run(id, req.user.id, d.name, d.description);
      db.prepare("INSERT INTO memberships(group_id,user_id) VALUES(?,?)").run(
        id,
        req.user.id,
      );
    });
    res.status(201).json({ id });
  });
  app.put(
    "/api/groups/:id/membership",
    requireAuth,
    requireWrite,
    (req, res) => {
      const { joined } = z
        .object({ joined: z.boolean() })
        .strict()
        .parse(req.body);
      const g = db
        .prepare(
          "SELECT g.* FROM groups g JOIN users u ON u.id=g.owner_id WHERE g.id=? AND u.banned=0",
        )
        .get(req.params.id);
      if (!g) fail(404, "Group not found.");
      if (!joined && g.owner_id === req.user.id)
        fail(409, "The owner must delete the group instead of leaving.");
      if (joined)
        db.prepare(
          "INSERT OR IGNORE INTO memberships(group_id,user_id) VALUES(?,?)",
        ).run(g.id, req.user.id);
      else
        db.prepare(
          "DELETE FROM memberships WHERE group_id=? AND user_id=?",
        ).run(g.id, req.user.id);
      res.json({ ok: true });
    },
  );
  app.delete("/api/groups/:id", requireAuth, (req, res) => {
    const g = db.prepare("SELECT * FROM groups WHERE id=?").get(req.params.id);
    if (!g) fail(404, "Group not found.");
    if (g.owner_id !== req.user.id)
      fail(403, "Only the owner can delete the group.");
    db.prepare("DELETE FROM groups WHERE id=?").run(g.id);
    res.json({ ok: true });
  });
  const member = (req, _, next) => {
    if (
      !db
        .prepare("SELECT 1 FROM memberships m JOIN groups g ON g.id=m.group_id JOIN users u ON u.id=g.owner_id WHERE m.group_id=? AND m.user_id=? AND u.banned=0")
        .get(req.params.id, req.user.id)
    )
      fail(403, "Join this group to access its conversation.");
    next();
  };
  app.get("/api/groups/:id/messages", requireAuth, member, (req, res) =>
    res.json(
      db
        .prepare(
          "SELECT m.* FROM group_messages m JOIN users u ON u.id=m.user_id WHERE m.group_id=? AND u.banned=0 AND NOT EXISTS(SELECT 1 FROM blocks b WHERE (b.user_id=? AND b.blocked_id=m.user_id) OR (b.user_id=m.user_id AND b.blocked_id=?)) ORDER BY m.created_at DESC,m.rowid DESC LIMIT 200",
        )
        .all(req.params.id, req.user.id, req.user.id)
        .reverse()
        .map((m) => ({
          ...m,
          author: publicUser(
            db.prepare("SELECT * FROM users WHERE id=?").get(m.user_id),
          ),
        })),
    ),
  );
  app.post(
    "/api/groups/:id/messages",
    requireAuth,
    requireWrite,
    member,
    (req, res) => {
      const { text: content } = z
        .object({ text: text(2000) })
        .strict()
        .parse(req.body);
      db.prepare(
        "INSERT INTO group_messages(id,group_id,user_id,text) VALUES(?,?,?,?)",
      ).run(randomUUID(), req.params.id, req.user.id, content);
      res.status(201).json({ ok: true });
    },
  );
  app.get("/api/decks", requireAuth, (req, res) =>
    res.json(
      db
        .prepare("SELECT * FROM decks WHERE user_id=? ORDER BY updated_at DESC")
        .all(req.user.id),
    ),
  );
  app.post("/api/decks", requireAuth, requireWrite, (req, res) => {
    const d = deckSchema.parse(req.body),
      id = randomUUID();
    db.prepare(
      "INSERT INTO decks(id,user_id,name,format,commander,list) VALUES(?,?,?,?,?,?)",
    ).run(id, req.user.id, d.name, d.format, d.commander, d.list);
    res.status(201).json({ id });
  });
  app.put("/api/decks/:id", requireAuth, requireWrite, (req, res) => {
    const d = deckSchema.parse(req.body);
    transaction(db, () => {
      const old = db
        .prepare("SELECT * FROM decks WHERE id=? AND user_id=?")
        .get(req.params.id, req.user.id);
      if (!old) fail(404, "Deck not found.");
      if (isPlus(db, req.user.id))
        db.prepare(
          "INSERT INTO deck_versions(id,deck_id,name,list,note) VALUES(?,?,?,?,?)",
        ).run(randomUUID(), old.id, old.name, old.list, d.note);
      db.prepare(
        "UPDATE decks SET name=?,format=?,commander=?,list=?,updated_at=CURRENT_TIMESTAMP WHERE id=?",
      ).run(d.name, d.format, d.commander, d.list, old.id);
    });
    res.json({ ok: true });
  });
  app.get("/api/decks/:id/versions", requireAuth, plus, (req, res) => {
    if (
      !db
        .prepare("SELECT 1 FROM decks WHERE id=? AND user_id=?")
        .get(req.params.id, req.user.id)
    )
      fail(404, "Deck not found.");
    res.json(
      db
        .prepare(
          "SELECT * FROM deck_versions WHERE deck_id=? ORDER BY created_at DESC,rowid DESC LIMIT 200",
        )
        .all(req.params.id),
    );
  });
  app.delete("/api/decks/:id", requireAuth, (req, res) => {
    if (
      !db
        .prepare("SELECT 1 FROM decks WHERE id=? AND user_id=?")
        .get(req.params.id, req.user.id)
    )
      fail(404, "Deck not found.");
    transaction(db, () => {
      db.prepare("UPDATE posts SET deck_id=NULL WHERE deck_id=?").run(
        req.params.id,
      );
      db.prepare("DELETE FROM decks WHERE id=?").run(req.params.id);
    });
    res.json({ ok: true });
  });
  app.get("/api/history", requireAuth, plus, (req, res) =>
    res.json(
      db
        .prepare(
          "SELECT l.*,d.name deck_name FROM game_logs l LEFT JOIN decks d ON d.id=l.deck_id WHERE l.user_id=? ORDER BY played_at DESC LIMIT 500",
        )
        .all(req.user.id),
    ),
  );
  app.post("/api/history", requireAuth, requireWrite, plus, (req, res) => {
    const d = z
      .object({
        deck_id: z.string().nullable(),
        format,
        result: z.enum(["win", "loss", "draw"]),
        notes: text(2000, 0),
        played_at: z.string().datetime(),
      })
      .strict()
      .parse(req.body);
    if (
      d.deck_id &&
      !db
        .prepare("SELECT 1 FROM decks WHERE id=? AND user_id=?")
        .get(d.deck_id, req.user.id)
    )
      fail(404, "Deck not found.");
    db.prepare(
      "INSERT INTO game_logs(id,user_id,deck_id,format,result,notes,played_at) VALUES(?,?,?,?,?,?,?)",
    ).run(
      randomUUID(),
      req.user.id,
      d.deck_id,
      d.format,
      d.result,
      d.notes,
      d.played_at,
    );
    res.status(201).json({ ok: true });
  });
  app.delete("/api/history/:id", requireAuth, (req, res) => {
    db.prepare("DELETE FROM game_logs WHERE id=? AND user_id=?").run(
      req.params.id,
      req.user.id,
    );
    res.json({ ok: true });
  });
  app.post("/api/reports", requireAuth, requireWrite, (req, res) => {
    const d = z
      .object({
        target_type: z.enum(["post", "comment", "user"]),
        target_id: text(100),
        reason: text(1000),
      })
      .strict()
      .parse(req.body);
    const table = { post: "posts", comment: "comments", user: "users" }[
      d.target_type
    ];
    if (!db.prepare(`SELECT 1 FROM ${table} WHERE id=?`).get(d.target_id))
      fail(404, "Report target not found.");
    db.prepare(
      "INSERT INTO reports(id,reporter_id,target_type,target_id,reason) VALUES(?,?,?,?,?)",
    ).run(randomUUID(), req.user.id, d.target_type, d.target_id, d.reason);
    res.status(201).json({ ok: true });
  });
  app.put("/api/blocks/:id", requireAuth, (req, res) => {
    const { blocked } = z
      .object({ blocked: z.boolean() })
      .strict()
      .parse(req.body);
    if (req.params.id === req.user.id) fail(400, "You cannot block yourself.");
    if (!db.prepare("SELECT 1 FROM users WHERE id=?").get(req.params.id))
      fail(404, "User not found.");
    if (blocked)
      db.prepare(
        "INSERT OR IGNORE INTO blocks(user_id,blocked_id) VALUES(?,?)",
      ).run(req.user.id, req.params.id);
    else
      db.prepare("DELETE FROM blocks WHERE user_id=? AND blocked_id=?").run(
        req.user.id,
        req.params.id,
      );
    res.json({ ok: true });
  });
  app.get("/api/blocks", requireAuth, (req, res) =>
    res.json(
      db
        .prepare(
          "SELECT u.* FROM blocks b JOIN users u ON u.id=b.blocked_id WHERE b.user_id=?",
        )
        .all(req.user.id)
        .map(publicUser),
    ),
  );
  app.get("/api/account/export", requireAuth, (req, res) => {
    const id = req.user.id;
    res.json({
      profile: ownUser(req.user),
      posts: db.prepare("SELECT * FROM posts WHERE user_id=?").all(id),
      comments: db.prepare("SELECT * FROM comments WHERE user_id=?").all(id),
      decks: db.prepare("SELECT * FROM decks WHERE user_id=?").all(id),
      deck_versions: db
        .prepare(
          "SELECT v.* FROM deck_versions v JOIN decks d ON d.id=v.deck_id WHERE d.user_id=?",
        )
        .all(id),
      game_logs: db.prepare("SELECT * FROM game_logs WHERE user_id=?").all(id),
      memberships: db
        .prepare("SELECT * FROM memberships WHERE user_id=?")
        .all(id),
      games: db.prepare("SELECT * FROM games WHERE host_id=?").all(id),
      attendees: db.prepare("SELECT * FROM attendees WHERE user_id=?").all(id),
      group_messages: db
        .prepare("SELECT * FROM group_messages WHERE user_id=?")
        .all(id),
      likes: db.prepare("SELECT * FROM likes WHERE user_id=?").all(id),
      bookmarks: db.prepare("SELECT * FROM bookmarks WHERE user_id=?").all(id),
      blocks: db.prepare("SELECT * FROM blocks WHERE user_id=?").all(id),
      subscriptions: db
        .prepare("SELECT * FROM subscriptions WHERE user_id=?")
        .all(id),
    });
  });
  app.delete("/api/account", requireAuth, async (req, res) => {
    const d = z
      .object({ password, confirm: z.literal("DELETE") })
      .strict()
      .parse(req.body);
    if (req.user.role === "admin")
      fail(
        409,
        "Administrators must use the server operator to remove their account.",
      );
    if (!(await verifyPassword(d.password, req.user.password_hash)))
      fail(401, "Incorrect password.");
    const subs = db
      .prepare(
        "SELECT id FROM subscriptions WHERE user_id=? AND provider='stripe' AND status NOT IN ('canceled','incomplete_expired')",
      )
      .all(req.user.id);
    if (subs.length && !stripe)
      fail(503, "Billing must be available to cancel your subscription first.");
    for (const s of subs) await stripe.subscriptions.cancel(s.id);
    transaction(db, () => {
      db.prepare(
        "UPDATE posts SET deck_id=NULL WHERE deck_id IN (SELECT id FROM decks WHERE user_id=?)",
      ).run(req.user.id);
      db.prepare("DELETE FROM users WHERE id=?").run(req.user.id);
    });
    res.clearCookie("tgs_session", { path: "/api" });
    res.json({ ok: true });
  });
  app.get("/api/billing/status", requireAuth, (req, res) =>
    res.json({
      ready: billingReady,
      plus: isPlus(db, req.user.id),
      subscriptions: db
        .prepare(
          "SELECT provider,status,period_end,cancel_at_period_end FROM subscriptions WHERE user_id=?",
        )
        .all(req.user.id),
    }),
  );
  const billing = (req, _, next) => {
    if (!billingReady) fail(503, "Subscriptions are not configured yet.");
    if (
      req.get("X-TGS-Platform") === "ios" ||
      req.get("X-TGS-Platform") === "android"
    )
      fail(
        409,
        "Native store purchases require the store billing integration.",
      );
    next();
  };
  app.post(
    "/api/billing/checkout",
    requireAuth,
    requireWrite,
    billing,
    async (req, res) => {
      const d = z
        .object({ interval: z.enum(["month", "year"]) })
        .strict()
        .parse(req.body);
      await serial(db, `checkout:${req.user.id}`, async () => {
        if (
          db
            .prepare(
              "SELECT 1 FROM subscriptions WHERE user_id=? AND status NOT IN ('canceled','incomplete_expired')",
            )
            .get(req.user.id)
        )
          fail(
            409,
            "Manage your existing subscription instead of creating another.",
          );
        let customer = req.user.stripe_customer;
        if (!customer) {
          const created = await stripe.customers.create(
            { email: req.user.email, metadata: { tgs_user_id: req.user.id } },
            { idempotencyKey: `tgs-customer-${req.user.id}` },
          );
          customer = created.id;
          db.prepare("UPDATE users SET stripe_customer=? WHERE id=?").run(
            customer,
            req.user.id,
          );
        }
        let pending = db
          .prepare("SELECT * FROM checkout_sessions WHERE user_id=?")
          .get(req.user.id);
        if (pending?.session_id) {
          const prior = await stripe.checkout.sessions.retrieve(
            pending.session_id,
          );
          if (prior.status === "open") {
            res.json({ url: prior.url });
            return;
          }
          if (prior.status === "complete" && prior.subscription) {
            await reconcileSubscription(db, stripe, prior.subscription, prices);
            db.prepare("DELETE FROM checkout_sessions WHERE user_id=?").run(req.user.id);
            if(db.prepare("SELECT 1 FROM subscriptions WHERE user_id=? AND status NOT IN ('canceled','incomplete_expired')").get(req.user.id))
              fail(409,"Your checkout is complete. Refresh membership or manage your subscription.");
          }
          db.prepare("DELETE FROM checkout_sessions WHERE user_id=?").run(
            req.user.id,
          );
          pending = null;
        }
        if (!pending) {
          pending = {
            idempotency_key: `tgs-checkout-${randomUUID()}`,
            interval: d.interval,
          };
          db.prepare(
            "INSERT INTO checkout_sessions(user_id,idempotency_key,expires_at,interval) VALUES(?,?,?,?)",
          ).run(
            req.user.id,
            pending.idempotency_key,
            now() + 86400,
            pending.interval,
          );
        }
        const session = await stripe.checkout.sessions.create(
          {
            mode: "subscription",
            customer,
            line_items: [
              {
                price:
                  pending.interval === "month"
                    ? config.monthlyPrice
                    : config.yearlyPrice,
                quantity: 1,
              },
            ],
            client_reference_id: req.user.id,
            subscription_data: { metadata: { tgs_user_id: req.user.id } },
            success_url: `${config.publicUrl}/?billing=success`,
            cancel_url: `${config.publicUrl}/?billing=canceled`,
          },
          { idempotencyKey: pending.idempotency_key },
        );
        db.prepare(
          "UPDATE checkout_sessions SET session_id=?,url=?,expires_at=? WHERE user_id=?",
        ).run(
          session.id,
          session.url,
          session.expires_at || now() + 86400,
          req.user.id,
        );
        res.json({ url: session.url });
      });
    },
  );
  app.post("/api/billing/portal", requireAuth, billing, async (req, res) => {
    const customer = db
      .prepare("SELECT stripe_customer FROM users WHERE id=?")
      .get(req.user.id).stripe_customer;
    if (!customer) fail(404, "No billing account yet.");
    const session = await stripe.billingPortal.sessions.create({
      customer,
      return_url: config.publicUrl,
    });
    res.json({ url: session.url });
  });
  app.post("/api/billing/refresh", requireAuth, async (req, res) => {
    if (!stripe) fail(503, "Billing is not configured.");
    const customer = req.user.stripe_customer;
    if (customer) {
      const list = await stripe.subscriptions.list({
        customer,
        status: "all",
        limit: 100,
      });
      for (const s of list.data)
        await reconcileSubscription(db, stripe, s.id, prices);
    }
    res.json({ plus: isPlus(db, req.user.id) });
  });
  app.post("/api/billing/store-sync", requireAuth, async (req, res) => {
    if (!config.rcSecret) fail(503, "Store billing is not configured.");
    await reconcileStore(db, config, req.user.id, storeFetch);
    res.json({ plus: isPlus(db, req.user.id) });
  });
  const audit = (actor, action, target, reason) =>
    db
      .prepare(
        "INSERT INTO audit_logs(actor_id,action,target_id,reason) VALUES(?,?,?,?)",
      )
      .run(actor, action, target, reason);
  app.get("/api/admin", requireAuth, admin, (_, res) =>
    res.json({
      users: db
        .prepare(
          "SELECT id,email,handle,name,role,banned,ban_reason,verified,created_at FROM users ORDER BY created_at DESC LIMIT 500",
        )
        .all(),
      posts: db
        .prepare(
          "SELECT p.*,u.name author FROM posts p JOIN users u ON u.id=p.user_id ORDER BY p.created_at DESC,p.rowid DESC LIMIT 200",
        )
        .all(),
      comments: db
        .prepare(
          "SELECT c.*,u.name author FROM comments c JOIN users u ON u.id=c.user_id ORDER BY c.created_at DESC,c.rowid DESC LIMIT 200",
        )
        .all(),
      reports: db
        .prepare("SELECT * FROM reports ORDER BY created_at DESC LIMIT 200")
        .all(),
      audit: db
        .prepare("SELECT * FROM audit_logs ORDER BY id DESC LIMIT 200")
        .all(),
    }),
  );
  app.put("/api/admin/users/:id/ban", requireAuth, admin, (req, res) => {
    const d = z
      .object({ banned: z.boolean(), reason: text(1000) })
      .strict()
      .parse(req.body);
    const u = db.prepare("SELECT * FROM users WHERE id=?").get(req.params.id);
    if (!u) fail(404, "User not found.");
    if (u.role === "admin")
      fail(409, "Administrator accounts cannot be banned through the app.");
    transaction(db, () => {
      db.prepare("UPDATE users SET banned=?,ban_reason=? WHERE id=?").run(
        Number(d.banned),
        d.reason,
        u.id,
      );
      if (d.banned) {
        db.prepare("DELETE FROM sessions WHERE user_id=?").run(u.id);
        db.prepare("DELETE FROM attendees WHERE user_id=?").run(u.id);
        db.prepare("DELETE FROM memberships WHERE user_id=?").run(u.id);
      } else {
        db.prepare("INSERT OR IGNORE INTO memberships(group_id,user_id) SELECT id,owner_id FROM groups WHERE owner_id=?").run(u.id);
      }
      audit(req.user.id, d.banned ? "ban_user" : "unban_user", u.id, d.reason);
    });
    res.json({ ok: true });
  });
  for (const [resource, table] of [
    ["posts", "posts"],
    ["comments", "comments"],
  ])
    app.put(
      `/api/admin/${resource}/:id/moderation`,
      requireAuth,
      admin,
      (req, res) => {
        const d = z
          .object({ deleted: z.boolean(), reason: text(1000) })
          .strict()
          .parse(req.body);
        if (!db.prepare(`SELECT 1 FROM ${table} WHERE id=?`).get(req.params.id))
          fail(404, "Content not found.");
        transaction(db, () => {
          db.prepare(`UPDATE ${table} SET deleted_at=? WHERE id=?`).run(
            d.deleted ? new Date().toISOString() : null,
            req.params.id,
          );
          audit(
            req.user.id,
            `${d.deleted ? "remove" : "restore"}_${resource}`,
            req.params.id,
            d.reason,
          );
        });
        res.json({ ok: true });
      },
    );
  app.put("/api/admin/reports/:id", requireAuth, admin, (req, res) => {
    const d = z
      .object({
        status: z.enum(["open", "resolved", "dismissed"]),
        reason: text(1000),
      })
      .strict()
      .parse(req.body);
    if (!db.prepare("SELECT 1 FROM reports WHERE id=?").get(req.params.id))
      fail(404, "Report not found.");
    transaction(db, () => {
      db.prepare("UPDATE reports SET status=? WHERE id=?").run(
        d.status,
        req.params.id,
      );
      audit(req.user.id, "review_report", req.params.id, d.reason);
    });
    res.json({ ok: true });
  });
  app.use("/api", (_, res) =>
    res.status(404).json({ error: "API route not found." }),
  );
  const web = resolve("dist");
  if (existsSync(web)) {
    app.use(express.static(web));
    app.get("/{*path}", (_, res) => res.sendFile(resolve(web, "index.html")));
  }
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof ZodError)
      return res
        .status(400)
        .json({
          error: err.issues
            .map((i) => `${i.path.join(".")}: ${i.message}`)
            .join("; "),
        });
    if (err.status && (err.status < 500 || err.expose))
      return res.status(err.status).json({ error: err.message });
    console.error("Request failed:", err.name);
    res
      .status(500)
      .json({ error: "The server could not complete this request." });
  });
  return app;
}
