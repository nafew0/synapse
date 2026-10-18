# Billing records: plan for later

Status: planned, not started (2026-10-18). Nothing in this document is built.

Usage packages decide what a person or an institution may spend. They do not record what anyone
paid. Today an assignment says "this user is on Plus until 30 November", and the price paid, the
discount, the payment reference and the history of renewals exist nowhere. This plan adds those
records without changing how the quota engine meters.

## 1. Goals

- Record every sale: who bought which package, for which period, at what price, with which
  discount, paid how, with which reference.
- Keep the assignment the quota engine reads (`User.usagePackage`, `Institution.usagePackage`,
  the individuals account) as the single place limits come from. A record drives the assignment;
  the engine never reads billing records.
- Show revenue against provider cost per package, institution and month.
- Support renewals, upgrades, cancellations and refunds, with an audit trail.
- Scale to many individuals and institutions with indexed queries only.

Out of scope here: a payment gateway (SSLCommerz, bKash, Nagad), self-service checkout and tax
invoices. The model below leaves room for them (section 7).

## 2. What exists today

| Piece | Where | Role after this plan |
|---|---|---|
| Package catalogue, BDT pricing | `UsagePackage`, `UsagePricing` | Unchanged. A sale snapshots the package and the rate. |
| Assignments | `User.usagePackage {packageKey, expiresAt, assignedBy}`, `Institution.usagePackage`, `UsageAccount` (individuals' trial) | Written by the billing service when a subscription starts, renews or ends. Manual assignment stays for complimentary access. |
| Provider cost | `Transaction.tokenValue` (credits, USD × 1e6) | The cost side of the revenue report. |
| Audit | `AuditLog` (`platform.usage_package_assigned` / `_revoked`) | Joined by new billing actions. |
| Discounts | Pricing workbook only | Recorded on each sale. |
| Old credit grants | Removed on 2026-10-18 (0 rows in production) | Not revived. |

## 3. Data model

Three collections in `packages/data-schemas`, platform-level (no tenant isolation plugin, like
`UsagePackage`), each with a `customer` reference so one query shape serves individuals and
institutions.

### `Subscription`: who holds which package, over time

```ts
interface ISubscription {
  customer: { kind: 'user' | 'institution'; id: ObjectId | string }; // user _id or tenantId
  packageKey: string;
  status: 'pending' | 'active' | 'past_due' | 'cancelled' | 'expired';
  currentPeriod: { start: Date; end: Date };
  renewal: 'manual' | 'auto';
  /** The package as sold: later edits to the catalogue never change past sales. */
  snapshot: { name: string; price: number; monthlyCredit: number; weeklyPercent: number };
  startedAt: Date;
  cancelledAt?: Date | null;
  createdBy: ObjectId;
}
```

At most one `active` subscription per customer (partial unique index on
`{ 'customer.kind', 'customer.id' }` where `status: 'active'`). An upgrade ends the old one and
starts a new one in the same transaction.

### `Invoice`: what was charged for a period

```ts
interface IInvoice {
  number: string;                 // SYN-2026-000123, from a counter document
  subscriptionId: ObjectId;
  customer: { kind: 'user' | 'institution'; id: ObjectId | string };
  period: { start: Date; end: Date };
  currency: 'BDT';
  lines: Array<{
    description: string;
    packageKey: string;
    listPrice: number;            // the package price at the time of sale
    discount?: { kind: 'percent' | 'amount'; value: number; reason: string; code?: string };
    amount: number;               // listPrice after the discount
  }>;
  subtotal: number;
  tax: { rate: number; amount: number } | null;   // decided before go-live, see section 8
  total: number;
  /** The rate that turned taka into credits for this sale. */
  pricingSnapshot: { bdtPerUsd: number; providerFeePercent: number };
  status: 'draft' | 'issued' | 'paid' | 'void' | 'refunded';
  issuedAt?: Date;
  dueAt?: Date;
}
```

### `Payment`: money received or returned

```ts
interface IPayment {
  invoiceId: ObjectId;
  method: 'bank_transfer' | 'cash' | 'bkash' | 'nagad' | 'card' | 'waiver';
  amount: number;                 // negative for a refund
  reference: string;              // bank or gateway reference
  receivedAt: Date;
  recordedBy: ObjectId | null;    // null when a gateway callback recorded it
  gateway?: { provider: string; transactionId: string; raw?: unknown };
}
```

Indexes: `Invoice { 'customer.id': 1, 'period.start': -1 }`, `Invoice { status: 1, dueAt: 1 }`,
`Invoice { number: 1 } unique`, `Payment { invoiceId: 1 }`,
`Payment { 'gateway.provider': 1, 'gateway.transactionId': 1 } unique sparse` (so a repeated
gateway callback records once), `Subscription { status: 1, 'currentPeriod.end': 1 }` for the
renewal sweep.

## 4. Lifecycle

| Event | Records | Assignment |
|---|---|---|
| Sale (admin records it) | `Subscription` active, `Invoice` issued, `Payment` if paid now | Sets the customer's package with `expiresAt = currentPeriod.end` |
| Payment arrives later | `Payment`, invoice `paid` | Unchanged |
| Renewal (manual or auto) | New period on the subscription, new invoice | Extends `expiresAt` |
| Period ends unpaid | Subscription `past_due`, then `expired` after a grace period | Cleared, so the trial or institution default applies |
| Upgrade or downgrade | Old subscription `cancelled`, new one `active`, invoice for the difference (proration rule in section 8) | Switches at once |
| Cancellation | `cancelledAt`; stays active to the period end | Expires at the period end |
| Refund | Negative `Payment`, invoice `refunded` | Cleared if the refund is full |
| Complimentary access | No billing records; manual assignment as today | As today |

A daily job (the same scheduler pattern as `reconcileQuotaState`) moves subscriptions whose period
has ended: renew `auto` ones, mark the rest `past_due` or `expired`, and clear the assignments.
Every transition writes an audit entry (`billing.subscription_started`, `billing.invoice_issued`,
`billing.payment_recorded`, `billing.refund_recorded`, and so on), fail-closed like the
assignment routes.

The quota engine already honours `User.usagePackage.expiresAt`, so expiry needs no engine change.
Institution assignments have no expiry today; add `expiresAt` to `InstitutionUsagePackage` when
institutional subscriptions are billed.

## 5. Code layout

- `packages/data-schemas`: schemas, types and methods for the three collections, plus a counter
  for invoice numbers.
- `packages/api/src/billing/`: `subscriptions.ts`, `invoices.ts`, `payments.ts` (pure pricing:
  discounts, proration, tax), `handlers.ts` (superadmin routes, built like
  `usage/assignments.ts`). The only module that writes assignments for paid customers.
- `api/server/routes/platform/billing.js`: a thin router behind `requirePlatformSuperadmin`.
- synapse-admin: a Billing page (subscriptions, invoices, payments, revenue report) and a
  "Sell package" action on the user and institution pages. Manual assignment stays as the
  complimentary path.

## 6. Reports

- **Revenue against cost**, per month and package: invoice totals (paid) next to provider cost,
  the sum of `Transaction.tokenValue` for the same customers and period, converted with the
  sale's `pricingSnapshot`. This replaces the margin column the pricing workbook estimates.
- **Receivables**: issued, unpaid invoices by due date.
- **Renewals due** in the next 7 and 30 days.

These read pre-aggregated monthly figures (a `BillingSummary` document per customer and month,
written by the daily job), not raw transactions, so the reports stay fast at scale.

## 7. Later: payment gateway and self-service

The `Payment.gateway` field and the unique gateway index let a gateway callback record a payment
idempotently. Self-service checkout would create a `pending` subscription and a draft invoice,
then activate both when the callback confirms payment. The webhook route must verify the
gateway's signature and never trust amounts from the client.

## 8. Decisions needed before building

1. **Tax**: is VAT charged on Synapse subscriptions, and at what rate? Do invoices need a BIN or
   Mushak format?
2. **Proration** on upgrade: charge the price difference for the rest of the period, or start a
   new full period?
3. **Grace period** before an unpaid subscription expires (suggestion: 7 days).
4. **Discounts**: free-form per sale (amount or percent with a reason), promo codes, or both?
5. **Who records sales**: platform superadmins only, or also a finance role with no other admin
   rights?
6. **Institution billing**: does an institution pay per month for its package, per seat, or a
   yearly contract?
7. **Invoice numbering and documents**: PDF invoices emailed to the customer, or records only?

## 9. Phases

1. Schemas, methods and the pricing module (discounts, proration, tax) with tests.
2. Recording sales and payments in the admin console; the assignment written from the
   subscription.
3. Renewal and expiry job; audit actions.
4. Reports and the monthly summaries.
5. Payment gateway and self-service checkout.
