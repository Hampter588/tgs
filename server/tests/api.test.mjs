import { test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import Stripe from "stripe";
import { openDatabase } from "../db.mjs";
import { createApp } from "../app.mjs";
import { configFromEnv } from "../config.mjs";
import { isPlus } from "../billing.mjs";
const password = "A secure test password 42!";
function fixture(overrides = {}) {
  const db = openDatabase(":memory:");
  const emails = [];
  const config = { ...configFromEnv({}), ...overrides.config };
  const app = createApp({
    db,
    config,
    disableRateLimits: true,
    sendMail: async (m) => emails.push(m),
    ...overrides,
  });
  const call = (method, path, token, body) => {
    const req = request(app)
      [method](`/api${path}`)
      .set("X-TGS-Client", "1")
      .set("Origin", config.publicUrl);
    if (token) req.set("Authorization", `Bearer ${token}`);
    return body === undefined ? req : req.send(body);
  };
  async function account(handle, admin = false) {
    const r = await call("post", "/auth/register", null, {
      email: `${handle}@example.com`,
      name: handle,
      handle,
      password,
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    if (admin)
      db.prepare("UPDATE users SET role='admin',verified=1 WHERE id=?").run(
        r.body.user.id,
      );
    return r.body;
  }
  return { db, app, config, call, account, emails };
}
test("registration hashes passwords, rejects privilege injection and duplicate handles", async () => {
  const f = fixture();
  try {
    const u = await f.account("alice");
    const row = f.db.prepare("SELECT * FROM users WHERE id=?").get(u.user.id);
    assert.notEqual(row.password_hash, password);
    assert.equal(row.role, "user");
    assert.equal(
      (
        await f.call("post", "/auth/register", null, {
          email: "evil@example.com",
          name: "evil",
          handle: "evil",
          password,
          role: "admin",
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await f.call("post", "/auth/register", null, {
          email: "other@example.com",
          name: "other",
          handle: "ALICE",
          password,
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await f.call("post", "/auth/login", null, {
          email: "alice@example.com",
          password: "wrong",
        })
      ).status,
      401,
    );
  } finally {
    f.db.close();
  }
});
test("sessions are revoked on logout and cookies require request protection", async () => {
  const f = fixture();
  try {
    const u = await f.account("alice");
    assert.equal((await f.call("get", "/auth/me", u.token)).status, 200);
    assert.equal(
      (await f.call("post", "/auth/logout", u.token, {})).status,
      200,
    );
    assert.equal((await f.call("get", "/auth/me", u.token)).status, 401);
    assert.equal(
      (
        await request(f.app)
          .post("/api/auth/login")
          .send({ email: "alice@example.com", password })
      ).status,
      403,
    );
    assert.equal(
      (
        await f.call("post", "/auth/login", null, {
          email: "alice@example.com",
          password,
        })
      ).status,
      200,
    );
  } finally {
    f.db.close();
  }
});
test("admins can ban users, invalidate old sessions, and unban without granting privileges", async () => {
  const f = fixture();
  try {
    const a = await f.account("admin", true),
      u = await f.account("alice");
    assert.equal((await f.call("get", "/admin", u.token)).status, 403);
    assert.equal(
      (
        await f.call("put", `/admin/users/${u.user.id}/ban`, u.token, {
          banned: true,
          reason: "test",
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await f.call("put", `/admin/users/${u.user.id}/ban`, a.token, {
          banned: true,
          reason: "Spam",
        })
      ).status,
      200,
    );
    assert.equal((await f.call("get", "/auth/me", u.token)).status, 401);
    assert.equal(
      (
        await f.call("post", "/auth/login", null, {
          email: "alice@example.com",
          password,
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await f.call("put", `/admin/users/${a.user.id}/ban`, a.token, {
          banned: true,
          reason: "test",
        })
      ).status,
      409,
    );
    await f.call("put", `/admin/users/${u.user.id}/ban`, a.token, {
      banned: false,
      reason: "Appeal accepted",
    });
    assert.equal(
      (
        await f.call("post", "/auth/login", null, {
          email: "alice@example.com",
          password,
        })
      ).body.user.role,
      "user",
    );
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM audit_logs").get().n, 2);
  } finally {
    f.db.close();
  }
});
test("post ownership, admin removal and restore, likes, bookmarks, comments and reports", async () => {
  const f = fixture();
  try {
    const a = await f.account("admin", true),
      u = await f.account("alice"),
      v = await f.account("bob");
    const p = await f.call("post", "/posts", u.token, {
      text: "My first deck",
      format: "Commander",
      type: "Discussion",
    });
    assert.equal(p.status, 201);
    assert.equal(
      (await f.call("delete", `/posts/${p.body.id}`, v.token)).status,
      403,
    );
    await f.call("put", `/posts/${p.body.id}/like`, v.token, { enabled: true });
    await f.call("put", `/posts/${p.body.id}/like`, v.token, { enabled: true });
    await f.call("put", `/posts/${p.body.id}/bookmark`, v.token, {
      enabled: true,
    });
    await f.call("post", `/posts/${p.body.id}/comments`, v.token, {
      text: "Looks great!",
    });
    const feed = await f.call("get", "/posts?saved=true", v.token);
    assert.equal(feed.body.items[0].likes, 1);
    assert.equal(feed.body.items[0].comments, 1);
    assert.equal(feed.body.items[0].author.email, undefined);
    await f.call("post", "/reports", v.token, {
      target_type: "post",
      target_id: p.body.id,
      reason: "Review please",
    });
    await f.call("put", `/admin/posts/${p.body.id}/moderation`, a.token, {
      deleted: true,
      reason: "Review pending",
    });
    assert.equal((await f.call("get", "/posts", v.token)).body.items.length, 0);
    assert.equal(
      (
        await f.call("post", `/posts/${p.body.id}/comments`, v.token, {
          text: "Hidden reply",
        })
      ).status,
      404,
    );
    await f.call("put", `/admin/posts/${p.body.id}/moderation`, a.token, {
      deleted: false,
      reason: "Restored",
    });
    assert.equal((await f.call("get", "/posts", v.token)).body.items.length, 1);
    const report = f.db.prepare("SELECT * FROM reports").get();
    await f.call("put", `/admin/reports/${report.id}`, a.token, {
      status: "resolved",
      reason: "Resolved",
    });
    assert.equal(
      f.db.prepare("SELECT status FROM reports").get().status,
      "resolved",
    );
  } finally {
    f.db.close();
  }
});
test("simultaneous RSVPs cannot overbook and repeated requests are idempotent", async () => {
  const f = fixture();
  try {
    const host = await f.account("host"),
      a = await f.account("alice"),
      b = await f.account("bob");
    const g = await f.call("post", "/games", host.token, {
      title: "Friday games",
      format: "Modern",
      location: "Game store",
      date: "2026-12-12",
      time: "18:30",
      timezone: "America/Los_Angeles",
      capacity: 2,
      description: "",
    });
    assert.equal(g.status, 201);
    const responses = await Promise.all([
      f.call("put", `/games/${g.body.id}/rsvp`, a.token, { joined: true }),
      f.call("put", `/games/${g.body.id}/rsvp`, b.token, { joined: true }),
    ]);
    assert.deepEqual(responses.map((r) => r.status).sort(), [200, 409]);
    const accepted = responses[0].status === 200 ? a : b;
    assert.equal(
      (
        await f.call("put", `/games/${g.body.id}/rsvp`, accepted.token, {
          joined: true,
        })
      ).status,
      200,
    );
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM attendees").get().n, 2);
    await f.call("put", `/games/${g.body.id}/rsvp`, accepted.token, {
      joined: false,
    });
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM attendees").get().n, 1);
  } finally {
    f.db.close();
  }
});
test("group conversations require membership and deck changes require ownership", async () => {
  const f = fixture();
  try {
    const a = await f.account("alice"),
      b = await f.account("bob");
    const g = await f.call("post", "/groups", a.token, {
      name: "Draft club",
      description: "Friends",
    });
    assert.equal(
      (await f.call("get", `/groups/${g.body.id}/messages`, b.token)).status,
      403,
    );
    await f.call("put", `/groups/${g.body.id}/membership`, b.token, {
      joined: true,
    });
    await f.call("post", `/groups/${g.body.id}/messages`, b.token, {
      text: "Hello!",
    });
    assert.equal(
      (await f.call("get", `/groups/${g.body.id}/messages`, a.token)).body[0]
        .text,
      "Hello!",
    );
    assert.equal(
      (
        await f.call("put", `/groups/${g.body.id}/membership`, a.token, {
          joined: false,
        })
      ).status,
      409,
    );
    const d = {
      name: "Burn",
      format: "Modern",
      commander: "",
      list: "4 Lightning Bolt",
    };
    const deck = await f.call("post", "/decks", a.token, d);
    assert.equal(
      (await f.call("put", `/decks/${deck.body.id}`, b.token, d)).status,
      404,
    );
    assert.equal(
      (await f.call("get", `/decks/${deck.body.id}/versions`, a.token)).status,
      402,
    );
  } finally {
    f.db.close();
  }
});
test("Plus is server enforced and expires; eligible members get revision history and logs", async () => {
  const f = fixture();
  try {
    const a = await f.account("alice");
    assert.equal((await f.call("get", "/history", a.token)).status, 402);
    assert.equal(
      (
        await f.call("patch", "/profile", a.token, {
          name: "Alice",
          handle: "alice",
          bio: "",
          format: "Modern",
          theme: "green",
        })
      ).status,
      402,
    );
    f.db
      .prepare(
        "INSERT INTO subscriptions(id,user_id,provider,status,period_end) VALUES(?,?,'stripe','active',?)",
      )
      .run("sub_test", a.user.id, Math.floor(Date.now() / 1000) + 3600);
    const d = {
      name: "Burn",
      format: "Modern",
      commander: "",
      list: "4 Lightning Bolt",
    };
    const deck = await f.call("post", "/decks", a.token, d);
    await f.call("put", `/decks/${deck.body.id}`, a.token, {
      ...d,
      list: "4 Lightning Bolt\n4 Lava Spike",
      note: "More burn",
    });
    assert.equal(
      (await f.call("get", `/decks/${deck.body.id}/versions`, a.token)).body[0]
        .list,
      "4 Lightning Bolt",
    );
    assert.equal(
      (
        await f.call("post", "/history", a.token, {
          deck_id: deck.body.id,
          format: "Modern",
          result: "win",
          notes: "Good game",
          played_at: new Date().toISOString(),
        })
      ).status,
      201,
    );
    assert.equal((await f.call("get", "/history", a.token)).body.length, 1);
    assert.equal(
      (
        await f.call("patch", "/profile", a.token, {
          name: "Alice",
          handle: "alice",
          bio: "",
          format: "Modern",
          theme: "green",
        })
      ).status,
      200,
    );
    f.db.prepare("UPDATE subscriptions SET period_end=0").run();
    assert.equal(isPlus(f.db, a.user.id), false);
    assert.equal(
      (await f.call("get", "/auth/me", a.token)).body.theme,
      "purple",
    );
    assert.equal((await f.call("get", "/history", a.token)).status, 402);
  } finally {
    f.db.close();
  }
});
test("email verification and password reset are one-time and revoke sessions", async () => {
  const f = fixture({
    config: { ...configFromEnv({}), requireVerification: true },
  });
  try {
    const a = await f.account("alice");
    assert.equal(
      (
        await f.call("post", "/posts", a.token, {
          text: "Hi",
          format: "Modern",
          type: "Discussion",
        })
      ).status,
      403,
    );
    const verify = new URL(
      f.emails[0].text.split(" ")[3].split("\n")[0],
    ).searchParams.get("verify");
    assert.equal(
      (await f.call("post", "/auth/verify", null, { token: verify })).status,
      200,
    );
    assert.equal(
      (await f.call("post", "/auth/verify", null, { token: verify })).status,
      400,
    );
    await f.call("post", "/auth/forgot", null, { email: "alice@example.com" });
    const reset = f.emails.at(-1).text.match(/reset=([^\s]+)/)[1];
    assert.equal(
      (
        await f.call("post", "/auth/reset", null, {
          token: reset,
          password: "A new password that is secure",
        })
      ).status,
      200,
    );
    assert.equal((await f.call("get", "/auth/me", a.token)).status, 401);
    assert.equal(
      (await f.call("post", "/auth/reset", null, { token: reset, password }))
        .status,
      400,
    );
  } finally {
    f.db.close();
  }
});
test("blocking hides both directions; account deletion removes owned data", async () => {
  const f = fixture();
  try {
    const a = await f.account("alice"),
      b = await f.account("bob");
    const p = await f.call("post", "/posts", a.token, {
      text: "Hello",
      format: "Pauper",
      type: "Discussion",
    });
    await f.call("put", `/blocks/${a.user.id}`, b.token, { blocked: true });
    assert.equal((await f.call("get", "/posts", b.token)).body.items.length, 0);
    assert.equal(
      (await f.call("get", `/posts/${p.body.id}/comments`, b.token)).status,
      404,
    );
    await f.call("put", `/blocks/${a.user.id}`, b.token, { blocked: false });
    assert.equal((await f.call("get", "/posts", b.token)).body.items.length, 1);
    const exported = await f.call("get", "/account/export", a.token);
    assert.equal(exported.body.profile.password_hash, undefined);
    assert.equal(
      (
        await f.call("delete", "/account", a.token, {
          password,
          confirm: "DELETE",
        })
      ).status,
      200,
    );
    assert.equal((await f.call("get", "/auth/me", a.token)).status, 401);
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM posts").get().n, 0);
  } finally {
    f.db.close();
  }
});
test("Stripe webhooks verify signatures, ignore replay and use current provider state", async () => {
  const stripe = new Stripe("sk_test_placeholder"),
    state = { status: "active", end: Math.floor(Date.now() / 1000) + 3600 };
  stripe.subscriptions.retrieve = async () => ({
    id: "sub_123",
    customer: "cus_123",
    status: state.status,
    cancel_at_period_end: false,
    items: {
      data: [{ price: { id: "price_month" }, current_period_end: state.end }],
    },
  });
  const f = fixture({
    config: {
      ...configFromEnv({}),
      stripeSecret: "sk_test_placeholder",
      webhookSecret: "whsec_test",
      monthlyPrice: "price_month",
      yearlyPrice: "price_year",
    },
    stripeClient: stripe,
  });
  try {
    const a = await f.account("alice");
    f.db
      .prepare("UPDATE users SET stripe_customer=? WHERE id=?")
      .run("cus_123", a.user.id);
    const payload = JSON.stringify({
      id: "evt_123",
      type: "customer.subscription.updated",
      data: { object: { id: "sub_123" } },
    });
    assert.equal(
      (
        await request(f.app)
          .post("/api/billing/webhook")
          .set("Content-Type", "application/json")
          .set("stripe-signature", "invalid")
          .send(payload)
      ).status,
      400,
    );
    const signature = stripe.webhooks.generateTestHeaderString({
      payload,
      secret: "whsec_test",
    });
    assert.equal(
      (
        await request(f.app)
          .post("/api/billing/webhook")
          .set("Content-Type", "application/json")
          .set("stripe-signature", signature)
          .send(payload)
      ).status,
      200,
    );
    assert.equal(isPlus(f.db, a.user.id), true);
    await request(f.app)
      .post("/api/billing/webhook")
      .set("Content-Type", "application/json")
      .set("stripe-signature", signature)
      .send(payload);
    assert.equal(
      f.db.prepare("SELECT COUNT(*) n FROM billing_events").get().n,
      1,
    );
    state.status = "canceled";
    const newer = JSON.stringify({
      id: "evt_124",
      type: "customer.subscription.updated",
      data: { object: { id: "sub_123", status: "active" } },
    });
    await request(f.app)
      .post("/api/billing/webhook")
      .set("Content-Type", "application/json")
      .set(
        "stripe-signature",
        stripe.webhooks.generateTestHeaderString({
          payload: newer,
          secret: "whsec_test",
        }),
      )
      .send(newer);
    assert.equal(isPlus(f.db, a.user.id), false);
  } finally {
    f.db.close();
  }
});
test("unconfigured billing and foreign origins fail closed", async () => {
  const f = fixture();
  try {
    const a = await f.account("alice");
    assert.equal(
      (
        await f.call("post", "/billing/checkout", a.token, {
          interval: "month",
        })
      ).status,
      503,
    );
    assert.equal(
      (
        await request(f.app)
          .get("/api/auth/me")
          .set("Origin", "https://evil.example")
          .set("Authorization", `Bearer ${a.token}`)
      ).status,
      403,
    );
    assert.equal(
      (
        await f.call("post", "/posts", a.token, {
          text: " ",
          format: "Modern",
          type: "Discussion",
        })
      ).status,
      400,
    );
  } finally {
    f.db.close();
  }
});
