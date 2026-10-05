import { serial } from "./locks.mjs";
export async function reconcileStore(db, config, userId, fetcher = fetch) {
  return serial(db, `revenuecat:${userId}`, async () => {
    if (!db.prepare("SELECT 1 FROM users WHERE id=?").get(userId)) return;
    const response = await fetcher(
      `https://api.revenuecat.com/v1/subscribers/${encodeURIComponent(userId)}`,
      {
        headers: { Authorization: `Bearer ${config.rcSecret}` },
        signal: AbortSignal.timeout(10000),
      },
    );
    if (!response.ok)
      throw Object.assign(
        new Error(
          "Store subscription verification is temporarily unavailable.",
        ),
        { status: 503, expose: true },
      );
    const { subscriber } = await response.json();
    const entitlement = subscriber?.entitlements?.[config.rcEntitlement];
    const product =
      subscriber?.subscriptions?.[entitlement?.product_identifier];
    const end = entitlement?.expires_date
      ? Math.floor(Date.parse(entitlement.expires_date) / 1000)
      : 0;
    const allowedSandbox = !config.production || !product?.is_sandbox;
    const active =
      Number.isFinite(end) &&
      end > Math.floor(Date.now() / 1000) &&
      allowedSandbox &&
      !product?.refunded_at;
    db.prepare(
      `INSERT INTO subscriptions(id,user_id,provider,status,price_id,period_end,cancel_at_period_end) VALUES(?,?,'revenuecat',?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,price_id=excluded.price_id,period_end=excluded.period_end,cancel_at_period_end=excluded.cancel_at_period_end,updated_at=CURRENT_TIMESTAMP`,
    ).run(
      `revenuecat:${userId}`,
      userId,
      active ? "active" : "expired",
      entitlement?.product_identifier || "",
      Number.isFinite(end) ? end : 0,
      Number(Boolean(product?.unsubscribe_detected_at)),
    );
  });
}
