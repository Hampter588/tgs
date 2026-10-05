import { Purchases } from "@revenuecat/purchases-capacitor";
import { send, platform } from "./api";
let configured = false,
  currentUser = null;
export async function offers(userId, config) {
  const apiKey = config.storeBilling?.[platform];
  if (!apiKey) throw new Error("Store subscriptions are not configured yet.");
  if (!configured) {
    await Purchases.configure({ apiKey, appUserID: userId });
    configured = true;
    currentUser = userId;
  } else if (currentUser !== userId) {
    await Purchases.logIn({ appUserID: userId });
    currentUser = userId;
  }
  const offerings = await Purchases.getOfferings();
  return offerings.current?.availablePackages || [];
}
export async function purchase(aPackage) {
  await Purchases.purchasePackage({ aPackage });
  await send("/billing/store-sync", {});
}
export async function restore() {
  await Purchases.restorePurchases();
  await send("/billing/store-sync", {});
}
