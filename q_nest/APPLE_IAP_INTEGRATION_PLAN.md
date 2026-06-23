# Apple In-App Purchase — Backend Integration Plan

Status: **PLAN (no code yet)** · Target: `q_nest` (NestJS + Prisma)
Goal: iOS subscriptions via Apple IAP, running alongside existing Stripe (web + Android), feeding the **same** subscription tables and feature-gating logic.

---

## 0. Guiding principle

This codebase already has a **provider-agnostic subscription system**. Apple is a third
billing provider alongside `stripe` and `admin_override` — not a parallel system.

> We do **NOT** add `apple_*` columns to the `users` table (as the original spec suggested).
> We reuse `user_subscriptions` (`billing_provider` + `external_id`) and the existing
> service methods, so all downstream side-effects (usage rows, QHQ rewards, onboarding
> drip, affiliate commissions, strategy activation) happen identically for Apple.

Confirmed decisions:
1. **Stripe ↔ Apple overlap → same block rule.** Apple `/verify` rejects if the user already
   has an active non-FREE subscription from any provider. User must cancel first.
   (Mirrors `stripe.controller.ts:59`.)
2. **Apple `originalTransactionId` is stored in the existing `user_subscriptions.external_id`** —
   exactly like Stripe stores its subscription id. Webhook lookups: `external_id + billing_provider='apple'`.

---

## 1. Existing architecture (what we build on)

| Concern | Where | Notes |
|---|---|---|
| Subscription source of truth | `user_subscriptions` (`schema.prisma:769`) | provider-neutral: `billing_provider`, `external_id`, `tier`, `billing_period`, `status`, `auto_renew`, `current_period_end`, `expires_at` |
| Feature-gating cache | `users.current_tier` (`schema.prisma:27`) | written inside every subscription txn; gating reads this, never the provider |
| Plan catalog / mapping target | `subscription_plans` (`schema.prisma:748`) | `@@unique([tier, billing_period])` → our Apple-product → plan lookup |
| Payments ledger | `payment_history` (`schema.prisma:887`) | provider-neutral: `payment_provider`, `external_payment_id`, `receipt_url` |
| Usage tracking | `subscription_usage` (`schema.prisma:843`) | auto-created by `createSubscription` |
| Auth context on requests | `SubscriptionLoaderMiddleware` (`app.module.ts:140`, `forRoutes('*')`) | populates `req.userId` + `req.subscriptionUser` from JWT on **all** routes |
| Raw body for webhooks | `main.ts:25` | `req.rawBody` captured globally |
| Existing Apple keys | `auth.service.ts` (`apple-signin-auth`, `APPLE_BUNDLE_ID`) | Sign-In only (login) — unrelated to billing, but p8/JWT handling is already familiar |

### Service methods to REUSE (do not reimplement)

- `subscriptionsService.createSubscription({ user_id, plan_id, billing_provider:'apple', external_id, auto_renew })` — `subscriptions.service.ts:457`. Already supports provider + external_id.
- `subscriptionsService.updateSubscription(id, {...})` — `:640`
- `subscriptionsService.recordPayment({...})` — `:954`
- `subscriptionsService.getActiveSubscriptionWithFeatures(userId)` — `:914`
- `finalizeCancellationLocal(subscriptionId, finalPeriodEnd)` — `:1136` (the revoke→FREE path). We add a thin `handleAppleSubscriptionCancelled(originalTransactionId, finalPeriodEnd)` wrapper that looks up by `external_id + billing_provider='apple'`, mirroring `handleStripeSubscriptionCancelled` (`:1073`).

The Stripe controller (`stripe.controller.ts:195+`) is the reference pattern: the webhook is thin glue that resolves user/plan and calls the above methods. **The Apple controller should be equally thin.**

---

## 2. Schema changes — minimal

Reusing `external_id` for `originalTransactionId` means **no required migration** for the core flow. One open item: **Apple environment (Sandbox/Production)**.

- Recommended: **no new column.** Handle environment with Apple's documented "production-first,
  fall back to sandbox on `21007`" pattern when calling the App Store Server API, and read it
  from the webhook payload directly. Store the resolved environment opportunistically in
  `payment_history` (provider context) if we ever need it for support.
- If we later want fast filtering of sandbox vs prod subs, add a single nullable
  `user_subscriptions.apple_environment VARCHAR(20)`. Not required for v1.

Net: **v1 ships with zero schema migration.** (Revisit only if environment filtering becomes a need.)

---

## 3. Apple product ID → internal plan mapping

Static map, Apple product id → `(PlanTier, BillingPeriod)`, then resolve `plan_id` via
`subscription_plans.findFirst({ where: { tier, billing_period } })`:

```
quantiva_pro_monthly         → (PRO,        MONTHLY)
quantiva_pro_quarterly       → (PRO,        QUARTERLY)
quantiva_pro_yearly          → (PRO,        YEARLY)
quantiva_elite_monthly       → (ELITE,      MONTHLY)
quantiva_elite_quarterly     → (ELITE,      QUARTERLY)
quantiva_elite_yearly        → (ELITE,      YEARLY)
quantiva_elite_plus_monthly  → (ELITE_PLUS, MONTHLY)
quantiva_elite_plus_quarterly→ (ELITE_PLUS, QUARTERLY)
quantiva_elite_plus_yearly   → (ELITE_PLUS, YEARLY)
```

Lives in the new module as a constant. Unknown product id → reject the request (do not guess).

---

## 4. New module: `src/modules/apple-iap/`

```
apple-iap/
  apple-iap.module.ts
  apple-iap.controller.ts        # 3 endpoints (verify, restore, webhook)
  apple-iap.service.ts           # JWT signing, App Store Server API calls, JWS verify, product map
  dto/                           # verify / restore request DTOs
  apple-product-map.ts           # the table above
```

Imports `SubscriptionsService`, `PrismaService`, `NotificationsService`, `AppGateway`,
`QhqTokenService` (same collaborators the Stripe controller uses).

Library choices (already aligned with repo):
- ES256 JWT signing for App Store Server API auth → `jsonwebtoken` (already a dependency) or `jose`.
- JWS verification of Apple webhook payloads → Apple's signed-payload chain; use `jose` for
  `compactVerify` against Apple's x5c cert chain, or the official
  `@apple/app-store-server-library` (Node) which bundles verification + decoding. **Prefer the
  official Apple library** to avoid hand-rolling cert-chain validation.

---

## 5. Endpoints

### 5.1 `POST /subscriptions/apple/verify`
Called by iOS after a StoreKit 2 purchase. Auth: bearer JWT → `req.userId` (middleware, free).

Logic:
1. `userId = req.subscriptionUser?.user_id` → 401 if missing.
2. **Overlap guard (decision #1):** query `user_subscriptions` for active non-FREE sub for this
   user (any provider). If found → `400 "Cancel your current subscription."` (mirrors `stripe.controller.ts:53-63`).
3. Map `productId` → `(tier, period)` → `plan_id`. Unknown product → 400.
4. **Verify with Apple App Store Server API** (`GET /inApps/v1/transactions/{transactionId}` or
   `subscriptions/{originalTransactionId}` status) using a signed ES256 JWT
   (`aud: appstoreconnect-v1`, `iss: ISSUER_ID`, `bid: BUNDLE_ID`, ≤1h). Production-first,
   fall back to sandbox. Confirm: bundle id matches, productId matches request, transaction
   not revoked, `expiresDate` in the future.
5. **Duplicate / account-sharing guard:** if a `user_subscriptions` row already has
   `external_id = originalTransactionId` (billing_provider `apple`):
   - same user → treat as restore (refresh status, return current).
   - different user → 409 "This Apple subscription is already linked to another account."
6. Create the subscription via `subscriptionsService.createSubscription({ billing_provider:'apple', external_id: originalTransactionId, ... })` (or `updateSubscription` if upgrading from a FREE row).
7. `recordPayment({ payment_provider:'apple', external_payment_id: transactionId, ... })`.
8. Return `{ success, tier, billing_period, expires_at, auto_renew }`.

> Note: with the overlap block rule, the "create vs update" branch is essentially: user is FREE
> (or no sub) → create; existing FREE row → update. No cross-provider switching happens here
> because step 2 blocks it.

### 5.2 `POST /subscriptions/apple/restore`
Same as verify steps 3–8, but step 5 "already linked to same user" is the **expected** path:
re-read Apple status, refresh `expires_at` / `auto_renew` / `status`, return current. Idempotent.

### 5.3 `POST /webhooks/apple` (App Store Server Notifications V2)
No bearer auth — authenticated by Apple's **JWS signature** on the `signedPayload`.

1. Verify `signedPayload` JWS against Apple's cert chain (official library). Reject if invalid.
2. Decode `notificationType` + `subtype`, and the nested `signedTransactionInfo` /
   `signedRenewalInfo`.
3. Find sub by `external_id = originalTransactionId AND billing_provider='apple'`.
4. Dispatch:

| notificationType | Action |
|---|---|
| `SUBSCRIBED` / `DID_RENEW` | extend `current_period_end` / `expires_at`, ensure tier active, `recordPayment` on renew |
| `DID_CHANGE_RENEWAL_STATUS` | set `auto_renew` per `autoRenewStatus`; **do not change tier** |
| `DID_FAIL_TO_RENEW` | grace period — keep access, **do not revoke**; rely on EXPIRED later |
| `EXPIRED` / `GRACE_PERIOD_EXPIRED` | `handleAppleSubscriptionCancelled(...)` → finalize to FREE |
| `REFUND` | revoke immediately → finalize to FREE regardless of `expires_at` |

5. Always return `200` (log failures for manual recovery) so Apple stops retrying — same
   posture as the Stripe webhook (`stripe.controller.ts:363`).

**Idempotency:** keep handlers idempotent (status checks already short-circuit in
`handleStripeSubscriptionCancelled:1085`); `payment_history.external_payment_id = latestTransactionId`
makes renewal replays safe.

---

## 6. Env vars (add to Render / `.env`)

```
APPLE_IAP_KEY_ID=
APPLE_IAP_ISSUER_ID=
APPLE_IAP_BUNDLE_ID=com.quantivahq.mobile     # confirm — differs from Sign-In bundle if any
APPLE_IAP_PRIVATE_KEY=                         # .p8 contents (\n-escaped, as with other keys)
APPLE_IAP_ENVIRONMENT=production               # default; verify falls back to sandbox automatically
```

App Store Connect setup (ops, not code): create 9 products with exact ids (§3), generate App
Store Server API key (.p8), configure Server Notifications V2 URLs (prod + sandbox both →
`/webhooks/apple`).

---

## 7. Feature gating — NO CHANGES

Gating reads `users.current_tier` / `user_subscriptions`, which Apple writes through the shared
service methods. The spec's `getUserActiveTier(source)` branch is **not needed** and will not be
added. Tiers (FREE/PRO/ELITE/ELITE_PLUS) and `plan_features` are untouched.

---

## 8. Edge cases (this codebase)

1. **Existing Stripe sub + Apple purchase** → blocked at verify (decision #1). Surface a clear
   message so iOS can tell the user to cancel on web first.
2. **Cancel in iOS Settings** → `DID_CHANGE_RENEWAL_STATUS` (`auto_renew=false`, keep access) →
   later `EXPIRED` → FREE.
3. **Refund** → `REFUND` → immediate FREE. Consider affiliate clawback parity:
   `handleStripeSubscriptionCancelled` calls `clawbackForSubscriptionIfRecent` (`:1105`) — the
   Apple cancel wrapper should do the same.
4. **Account sharing (one Apple sub, many Quantiva users)** → first to link wins via the
   `external_id` uniqueness check in verify step 5; later attempts → 409.
5. **Sandbox vs production** → production-first, fall back on `21007`; trust the environment field
   in webhook payloads.

---

## 9. Build order

1. `apple-iap` module skeleton + product map + DTOs.
2. Apple auth + App Store Server API client (sign ES256 JWT, fetch transaction/status).
3. `/verify` (+ overlap guard, duplicate guard) → wire to `createSubscription`/`recordPayment`.
4. `/restore`.
5. `handleAppleSubscriptionCancelled` wrapper in `subscriptions.service.ts`.
6. `/webhooks/apple` (JWS verify + notification dispatch).
7. Sandbox testing (fast renewal cadence).

No DB migration required for v1.
