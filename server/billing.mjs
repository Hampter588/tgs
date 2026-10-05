import { transaction } from "./db.mjs";
import { serial } from "./locks.mjs";
export function isPlus(db, userId, now = Math.floor(Date.now() / 1000)) {
  return Boolean(
    db
      .prepare(
        "SELECT 1 FROM subscriptions WHERE user_id=? AND status IN ('active','trialing') AND period_end>? LIMIT 1",
      )
      .get(userId, now),
  );
}
// Retrieve the current subscription rather than trusting webhook order or client redirects.
export async function reconcileSubscription(
  db,
  stripe,
  subscriptionId,
  prices,
) {
  return serial(db, `stripe:${subscriptionId}`, async () => {
    const sub = await stripe.subscriptions.retrieve(subscriptionId);
    const customer =
      typeof sub.customer === "string" ? sub.customer : sub.customer.id;
    const user = db
      .prepare("SELECT id FROM users WHERE stripe_customer=?")
      .get(customer);
    if (!user) return;
    const item = sub.items.data.find((item) => prices.includes(item.price.id));
    const end = item?.current_period_end || sub.current_period_end || 0;
    db.prepare(
      `INSERT INTO subscriptions(id,user_id,provider,status,price_id,period_end,cancel_at_period_end) VALUES(?,?,'stripe',?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET status=excluded.status,price_id=excluded.price_id,period_end=excluded.period_end,cancel_at_period_end=excluded.cancel_at_period_end,updated_at=CURRENT_TIMESTAMP`,
    ).run(
      sub.id,
      user.id,
      item ? sub.status : "unsupported",
      item?.price.id || "",
      end,
      Number(sub.cancel_at_period_end),
    );
  });
}
export async function handleBillingEvent(db, stripe, event, prices) {
  if (db.prepare("SELECT 1 FROM billing_events WHERE id=?").get(event.id))
    return;
  const object = event.data.object;
  const subId = event.type.startsWith("customer.subscription.")
    ? object.id
    : event.type.startsWith("checkout.session.")
      ? object.subscription
      : event.type.startsWith("invoice.")
        ? object.parent?.subscription_details?.subscription ||
          object.subscription
        : null;
  if (subId)
    await reconcileSubscription(
      db,
      stripe,
      typeof subId === "string" ? subId : subId.id,
      prices,
    );
  transaction(db, () =>
    db
      .prepare("INSERT OR IGNORE INTO billing_events(id) VALUES(?)")
      .run(event.id),
  );
}
