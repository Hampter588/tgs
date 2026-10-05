import React, { useEffect, useState } from "react";
import { offers, purchase, restore } from "./storeBilling";
import { platform } from "./api";
export default function MobilePlus({ user, config, changed }) {
  const [packages, setPackages] = useState([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    if (config.storeBilling?.[platform])
      offers(user.id, config)
        .then(setPackages)
        .catch((e) => setError(e.message));
  }, [user.id]);
  async function run(fn) {
    setBusy(true);
    setError("");
    try {
      await fn();
      await changed();
    } catch (e) {
      setError(
        e.userCancelled
          ? "Purchase canceled."
          : e.message || "The store could not complete this purchase.",
      );
    } finally {
      setBusy(false);
    }
  }
  if (!config.storeBilling?.[platform])
    return (
      <div className="notice">
        Store subscriptions are not yet enabled. Your existing membership
        remains available.
      </div>
    );
  return (
    <div className="stack-buttons">
      {error && (
        <p role="alert" className="notice error">
          {error}
        </p>
      )}
      {!user.plus &&
        packages
          .filter((p) => ["MONTHLY", "ANNUAL"].includes(p.packageType))
          .map((p) => (
            <button
              className="primary"
              key={p.identifier}
              disabled={busy}
              onClick={() => run(() => purchase(p))}
            >
              {p.packageType === "ANNUAL" ? "Yearly" : "Monthly"} ·{" "}
              {p.product.priceString}
            </button>
          ))}
      {!packages.length && !error && (
        <p className="muted">
          No subscription products are available in this store yet.
        </p>
      )}
      <button
        className="secondary"
        disabled={busy}
        onClick={() => run(restore)}
      >
        Restore purchases
      </button>
      <a
        className="secondary"
        href={
          platform === "ios"
            ? "https://apps.apple.com/account/subscriptions"
            : "https://play.google.com/store/account/subscriptions"
        }
        target="_blank"
        rel="noopener noreferrer"
      >
        Manage store subscription
      </a>
      <p className="muted">
        Subscriptions renew automatically until canceled through your store
        account. The store confirms price and terms before payment.
      </p>
    </div>
  );
}
