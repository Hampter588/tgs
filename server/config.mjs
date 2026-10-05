export function configFromEnv(env = process.env) {
  const production = env.NODE_ENV === "production";
  const publicUrl = (env.PUBLIC_URL || "http://localhost:3001").replace(
    /\/$/,
    "",
  );
  if (production && !publicUrl.startsWith("https://"))
    throw new Error("PUBLIC_URL must use HTTPS in production.");
  if (production && (!env.SMTP_HOST || !env.MAIL_FROM))
    throw new Error("SMTP_HOST and MAIL_FROM are required in production.");
  return {
    production,
    publicUrl,
    requireVerification:
      production || env.REQUIRE_EMAIL_VERIFICATION === "true",
    origins: [
      publicUrl,
      "http://localhost",
      "https://localhost",
      "capacitor://localhost",
      "app://tgs",
      ...(!production
        ? ["http://127.0.0.1:5173", "http://localhost:5173"]
        : []),
      ...(env.ALLOWED_ORIGINS || "").split(",").filter(Boolean),
    ],
    stripeSecret: env.STRIPE_SECRET_KEY,
    webhookSecret: env.STRIPE_WEBHOOK_SECRET,
    monthlyPrice: env.STRIPE_MONTHLY_PRICE_ID,
    yearlyPrice: env.STRIPE_YEARLY_PRICE_ID,
    smtp: env.SMTP_HOST
      ? {
          host: env.SMTP_HOST,
          port: Number(env.SMTP_PORT || 587),
          secure: env.SMTP_SECURE === "true",
          ...(env.SMTP_USER
            ? { auth: { user: env.SMTP_USER, pass: env.SMTP_PASSWORD } }
            : {}),
        }
      : null,
    mailFrom: env.MAIL_FROM || "TGS <noreply@localhost>",
    trustProxy: env.TRUST_PROXY ? Number(env.TRUST_PROXY) : false,
    rcSecret: env.REVENUECAT_SECRET_KEY,
    rcWebhook: env.REVENUECAT_WEBHOOK_AUTHORIZATION,
    rcEntitlement: env.REVENUECAT_ENTITLEMENT || "tgs_plus",
    rcIosKey: env.REVENUECAT_IOS_PUBLIC_KEY,
    rcAndroidKey: env.REVENUECAT_ANDROID_PUBLIC_KEY,
  };
}
