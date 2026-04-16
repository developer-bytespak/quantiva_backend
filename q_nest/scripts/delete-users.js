/**
 * Delete target users + all linked rows from whatever DB DATABASE_URL points at.
 *
 * Uses Prisma relation filters (subqueries) instead of pre-computed ID arrays,
 * so it handles users with thousands of linked rows without hitting Postgres's
 * 32767 bind-variable limit.
 *
 * Usage:
 *   node scripts/delete-users.js          # preview only
 *   node scripts/delete-users.js --apply  # actually delete
 */

require('dotenv').config();
const { PrismaClient } = require('@prisma/client');

const EXACT_EMAILS = [
  'muhammadaliyanmalik1@gmail.com',
  'ameerun35@gmail.com',
];

// case-insensitive prefix matches on email
const PREFIX_PATTERNS = [];

const APPLY = process.argv.includes('--apply');

const prisma = new PrismaClient();

async function main() {
  const target = process.env.DATABASE_URL?.split('@')[1]?.split('?')[0] || 'unknown';
  console.log(`DB target: ${target}`);
  console.log(`Mode:      ${APPLY ? 'APPLY (deleting)' : 'PREVIEW (read-only)'}\n`);

  const whereOr = [
    ...(EXACT_EMAILS.length ? [{ email: { in: EXACT_EMAILS } }] : []),
    ...PREFIX_PATTERNS.map((p) => ({ email: { startsWith: p, mode: 'insensitive' } })),
  ];

  const users = await prisma.users.findMany({
    where: { OR: whereOr },
    select: { user_id: true, email: true },
    orderBy: { email: 'asc' },
  });

  console.log(`Selection criteria:`);
  console.log(`  exact: ${EXACT_EMAILS.join(', ') || '(none)'}`);
  console.log(`  prefix (case-insensitive): ${PREFIX_PATTERNS.join(', ') || '(none)'}`);
  console.log(`\nUsers matched: ${users.length}`);
  users.forEach((u) => console.log(`  ${u.email.padEnd(40)} ${u.user_id}`));
  const missingExact = EXACT_EMAILS.filter(
    (e) => !users.some((u) => u.email.toLowerCase() === e.toLowerCase()),
  );
  if (missingExact.length) console.log(`  (missing exact: ${missingExact.join(', ')})`);

  if (users.length === 0) {
    console.log('\nNothing to delete.');
    return;
  }

  const userIds = users.map((u) => u.user_id);

  // Shared relation filters — all expressed as subqueries so Postgres doesn't
  // see a giant IN-list of UUIDs.
  const whereUser = { user_id: { in: userIds } };
  const whereViaPortfolio = { portfolio: whereUser };
  const whereViaStrategy = { strategy: whereUser };
  const whereViaSignal = { signal: whereUser };
  const whereViaOptimization = { optimization_runs: whereUser };
  const whereViaKyc = { kyc_verifications: whereUser };
  const whereViaMember = { member: whereUser };
  const whereViaReservation = { reservation: whereUser };
  const whereViaSubscription = { subscription: whereUser };
  const whereViaOrder = { order: { portfolio: whereUser } };
  const whereViaOptionsOrder = { originating_order: whereUser };

  // ---------- Preview counts ----------
  const counts = {};
  const count = async (label, promise) => { counts[label] = await promise; };

  await Promise.all([
    count('users', prisma.users.count({ where: whereUser })),
    count('user_sessions', prisma.user_sessions.count({ where: whereUser })),
    count('two_factor_codes', prisma.two_factor_codes.count({ where: whereUser })),
    count('user_settings', prisma.user_settings.count({ where: whereUser })),
    count('notifications', prisma.notifications.count({ where: whereUser })),
    count('kyc_verifications', prisma.kyc_verifications.count({ where: whereUser })),
    count('kyc_documents', prisma.kyc_documents.count({ where: whereViaKyc })),
    count('kyc_face_matches', prisma.kyc_face_matches.count({ where: whereViaKyc })),
    count('user_exchange_connections', prisma.user_exchange_connections.count({ where: whereUser })),
    count('strategies', prisma.strategies.count({ where: whereUser })),
    count('strategy_parameters', prisma.strategy_parameters.count({ where: whereViaStrategy })),
    count('strategy_execution_jobs', prisma.strategy_execution_jobs.count({ where: whereViaStrategy })),
    count('strategy_signals', prisma.strategy_signals.count({ where: whereUser })),
    count('signal_details', prisma.signal_details.count({ where: whereViaSignal })),
    count('signal_explanations', prisma.signal_explanations.count({ where: whereViaSignal })),
    count('auto_trade_evaluations', prisma.auto_trade_evaluations.count({ where: whereViaSignal })),
    count('portfolios', prisma.portfolios.count({ where: whereUser })),
    count('portfolio_positions', prisma.portfolio_positions.count({ where: whereViaPortfolio })),
    count('portfolio_snapshots', prisma.portfolio_snapshots.count({ where: whereViaPortfolio })),
    count('drawdown_history', prisma.drawdown_history.count({ where: whereViaPortfolio })),
    count('orders', prisma.orders.count({ where: whereViaPortfolio })),
    count('order_executions', prisma.order_executions.count({ where: whereViaOrder })),
    count('optimization_runs', prisma.optimization_runs.count({ where: whereUser })),
    count('optimization_allocations', prisma.optimization_allocations.count({ where: whereViaOptimization })),
    count('rebalance_suggestions', prisma.rebalance_suggestions.count({ where: whereViaOptimization })),
    count('risk_events', prisma.risk_events.count({ where: whereUser })),
    count('user_subscriptions', prisma.user_subscriptions.count({ where: whereUser })),
    count('subscription_usage', prisma.subscription_usage.count({ where: whereUser })),
    count('payment_history', prisma.payment_history.count({ where: whereUser })),
    count('vc_pool_seat_reservations', prisma.vc_pool_seat_reservations.count({ where: whereUser })),
    count('vc_pool_payment_submissions', prisma.vc_pool_payment_submissions.count({ where: whereUser })),
    count('vc_pool_members', prisma.vc_pool_members.count({ where: whereUser })),
    count('vc_pool_payouts', prisma.vc_pool_payouts.count({ where: whereViaMember })),
    count('vc_pool_cancellations', prisma.vc_pool_cancellations.count({ where: whereViaMember })),
    count('vc_pool_transactions', prisma.vc_pool_transactions.count({ where: whereUser })),
    count('user_credits', prisma.user_credits.count({ where: whereUser })),
    count('options_orders', prisma.options_orders.count({ where: whereUser })),
    count('options_positions', prisma.options_positions.count({ where: whereUser })),
    count('trade_fees', prisma.trade_fees.count({ where: whereUser })),
    count('monthly_fee_summaries', prisma.monthly_fee_summaries.count({ where: whereUser })),
    count('qhq_balances', prisma.qhq_balances.count({ where: whereUser })),
    count('qhq_transactions', prisma.qhq_transactions.count({ where: whereUser })),
    count('qhq_wallet_links', prisma.qhq_wallet_links.count({ where: whereUser })),
    count('onboarding_email_reminders', prisma.onboarding_email_reminders.count({ where: whereUser })),
    count('contact_submissions', prisma.contact_submissions.count({ where: whereUser })),
    count('pending_queued_trades', prisma.pending_queued_trades.count({ where: whereUser })),
  ]);

  console.log('\nRows that will be deleted (preview):');
  let total = 0;
  for (const [k, v] of Object.entries(counts)) {
    if (v > 0) {
      console.log(`  ${k.padEnd(34)} ${v}`);
      total += v;
    }
  }
  console.log(`  TOTAL (incl. users)                ${total}`);

  if (!APPLY) {
    console.log('\nPreview only. Re-run with --apply to delete.');
    return;
  }

  console.log('\nDeleting in transaction...');
  await prisma.$transaction(async (tx) => {
    // Deepest children first, then upward.

    // Order executions -> via orders -> via portfolios -> via user
    await tx.order_executions.deleteMany({ where: whereViaOrder });

    // Signal children
    await tx.auto_trade_evaluations.deleteMany({ where: whereViaSignal });
    await tx.signal_details.deleteMany({ where: whereViaSignal });
    await tx.signal_explanations.deleteMany({ where: whereViaSignal });
    await tx.options_signals.deleteMany({ where: whereViaSignal });

    // Null out orders.signal_id for orders that reference user's signals (but
    // belong to other portfolios — unlikely, but safe)
    await tx.orders.updateMany({
      where: { signal: whereUser },
      data: { signal_id: null },
    });

    // Orders (portfolio-scoped)
    await tx.orders.deleteMany({ where: whereViaPortfolio });

    // Portfolio children
    await tx.portfolio_positions.deleteMany({ where: whereViaPortfolio });
    await tx.portfolio_snapshots.deleteMany({ where: whereViaPortfolio });
    await tx.drawdown_history.deleteMany({ where: whereViaPortfolio });

    // Optimization children
    await tx.optimization_allocations.deleteMany({ where: whereViaOptimization });
    await tx.rebalance_suggestions.deleteMany({ where: whereViaOptimization });

    // Options positions (via originating order + user-scoped)
    await tx.options_positions.deleteMany({ where: whereViaOptionsOrder });
    await tx.options_positions.deleteMany({ where: whereUser });
    await tx.options_orders.deleteMany({ where: whereUser });

    // Strategy signals
    await tx.strategy_signals.deleteMany({ where: whereUser });

    // Strategy children
    await tx.strategy_parameters.deleteMany({ where: whereViaStrategy });
    await tx.strategy_execution_jobs.deleteMany({ where: whereViaStrategy });

    // Null out template_id on clones pointing at user's strategies
    await tx.strategies.updateMany({
      where: { template: whereUser },
      data: { template_id: null },
    });

    await tx.strategies.deleteMany({ where: whereUser });
    await tx.portfolios.deleteMany({ where: whereUser });
    await tx.optimization_runs.deleteMany({ where: whereUser });

    // KYC
    await tx.kyc_documents.deleteMany({ where: whereViaKyc });
    await tx.kyc_face_matches.deleteMany({ where: whereViaKyc });
    await tx.kyc_verifications.deleteMany({ where: whereUser });

    // Exchange connections
    await tx.user_exchange_connections.deleteMany({ where: whereUser });

    // VC pool member children
    await tx.vc_pool_cancellations.deleteMany({ where: whereViaMember });
    await tx.vc_pool_payouts.deleteMany({ where: whereViaMember });
    // Null out member_id on transactions pointing at user's members
    await tx.vc_pool_transactions.updateMany({
      where: { member: whereUser },
      data: { member_id: null },
    });

    await tx.vc_pool_transactions.deleteMany({ where: whereUser });
    // Payment submissions: by reservation (user) AND by user_id
    await tx.vc_pool_payment_submissions.deleteMany({ where: whereViaReservation });
    await tx.vc_pool_payment_submissions.deleteMany({ where: whereUser });
    await tx.vc_pool_seat_reservations.deleteMany({ where: whereUser });
    await tx.vc_pool_members.deleteMany({ where: whereUser });

    // Credits, fees
    await tx.user_credits.deleteMany({ where: whereUser });
    await tx.trade_fees.deleteMany({ where: whereUser });
    await tx.monthly_fee_summaries.deleteMany({ where: whereUser });

    // QHQ
    await tx.qhq_balances.deleteMany({ where: whereUser });
    await tx.qhq_transactions.deleteMany({ where: whereUser });
    await tx.qhq_wallet_links.deleteMany({ where: whereUser });

    // Subscriptions
    await tx.subscription_usage.deleteMany({ where: whereViaSubscription });
    await tx.payment_history.deleteMany({ where: whereViaSubscription });
    await tx.subscription_usage.deleteMany({ where: whereUser });
    await tx.payment_history.deleteMany({ where: whereUser });
    await tx.user_subscriptions.deleteMany({ where: whereUser });

    // Misc
    await tx.risk_events.deleteMany({ where: whereUser });
    await tx.notifications.deleteMany({ where: whereUser });
    await tx.onboarding_email_reminders.deleteMany({ where: whereUser });
    await tx.contact_submissions.updateMany({ where: whereUser, data: { user_id: null } });
    await tx.user_sessions.deleteMany({ where: whereUser });
    await tx.two_factor_codes.deleteMany({ where: whereUser });
    await tx.user_settings.deleteMany({ where: whereUser });
    await tx.pending_queued_trades.deleteMany({ where: whereUser });

    // Finally, users
    const res = await tx.users.deleteMany({ where: whereUser });
    console.log(`  users deleted: ${res.count}`);
  }, { timeout: 600_000, maxWait: 30_000 });

  const remaining = await prisma.users.count({ where: { OR: whereOr } });
  console.log(`\nRemaining users in DB matching criteria: ${remaining}`);
  console.log('Done.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
