/**
 * Export an authenticity-graded breakdown of every Quantiva user to a markdown file.
 *
 * Pulls every signal we have (sessions, KYC, payments, exchanges, subs, profile completeness),
 * scores each user, sorts by score, and buckets the result so it's obvious who's authentic.
 *
 * Usage:
 *   npx ts-node scripts/export-users-authenticity.ts [output-path]
 *
 * Default output path: ./users-authenticity-report.md (at repo root, alongside the
 * existing users-onboarding-report.md).
 */

import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import { PrismaClient } from '@prisma/client';

dotenv.config();

interface Row {
  user_id: string;
  email: string;
  username: string;
  full_name: string | null;
  email_verified: boolean;
  kyc_status: string;
  current_tier: string;
  onboarding_state: string;
  phone_number: string | null;
  nationality: string | null;
  created_at: Date;
  sessions: number;
  kyc_verifications: number;
  subscriptions: number;
  exchange_connections: number;
  payment_history: number;
  signals: number;
  strategies: number;
}

function scoreOf(u: Row): number {
  let s = 0;
  if (u.sessions > 0) s += 3;                          // logged in at least once (proves email access via 2FA)
  if (u.full_name) s += 1;
  if (u.phone_number) s += 1;
  if (u.onboarding_state !== 'SIGNED_UP') s += 2;
  if (u.kyc_verifications > 0) s += 3;
  if (u.kyc_status === 'approved') s += 2;
  if (u.exchange_connections > 0) s += 3;
  if (u.subscriptions > 0) s += 2;
  if (u.payment_history > 0) s += 3;
  if (u.current_tier !== 'FREE') s += 2;
  if (u.onboarding_state === 'COMPLETED') s += 3;
  return s;
}

function isLikelyTestAccount(u: Row): boolean {
  const e = u.email.toLowerCase();
  if (e.endsWith('@bytesplatform.com')) return true;
  if (e === 'test@gmail.com') return true;
  if (u.phone_number && /^(\+?1?555|12345)/.test(u.phone_number)) return true;
  return false;
}

function bucketOf(u: Row): string {
  if (isLikelyTestAccount(u)) return 'Test / Internal';
  if (u.onboarding_state === 'COMPLETED') return 'Completed (fully onboarded)';
  if (u.onboarding_state === 'CONNECT_EXCHANGE') return 'Connecting exchange';
  if (u.onboarding_state === 'PAID') return 'Paid / acknowledged plan';
  if (u.kyc_verifications > 0) return 'KYC submitted';
  if (u.onboarding_state === 'PERSONAL_INFO') return 'Personal info filled';
  if (u.sessions > 0) return 'Logged in but no further action';
  return 'Ghost (signed up, never returned)';
}

function esc(v: string | null | undefined): string {
  if (!v) return '—';
  return v.replace(/\|/g, '\\|');
}

function tableHeader(): string {
  return (
    '| Score | Verified | Email | Name | Tier | KYC | State | Sessions | KYC | Subs | Exch | Pay | Signed |\n' +
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|\n'
  );
}

function tableRow(u: Row, score: number): string {
  return (
    `| ${score} ` +
    `| ${u.email_verified ? '✓' : '—'} ` +
    `| ${esc(u.email)} ` +
    `| ${esc(u.full_name)} ` +
    `| ${u.current_tier} ` +
    `| ${u.kyc_status} ` +
    `| ${u.onboarding_state} ` +
    `| ${u.sessions} ` +
    `| ${u.kyc_verifications} ` +
    `| ${u.subscriptions} ` +
    `| ${u.exchange_connections} ` +
    `| ${u.payment_history} ` +
    `| ${u.created_at.toISOString().slice(0, 10)} |`
  );
}

async function main() {
  const outArg = process.argv[2];
  const outPath = outArg
    ? path.resolve(outArg)
    : path.resolve(process.cwd(), '..', '..', 'users-authenticity-report.md');

  const prisma = new PrismaClient();
  try {
    const raw = await prisma.users.findMany({
      select: {
        user_id: true, email: true, username: true, full_name: true,
        email_verified: true, kyc_status: true, current_tier: true,
        onboarding_state: true, phone_number: true, nationality: true,
        created_at: true,
        _count: {
          select: {
            sessions: true, kyc_verifications: true, subscriptions: true,
            exchange_connections: true, payment_history: true,
            signals: true, strategies: true,
          },
        },
      },
      orderBy: { created_at: 'asc' },
    });

    const rows: Row[] = raw.map((u) => ({
      user_id: u.user_id,
      email: u.email,
      username: u.username,
      full_name: u.full_name,
      email_verified: u.email_verified,
      kyc_status: String(u.kyc_status),
      current_tier: String(u.current_tier),
      onboarding_state: String(u.onboarding_state),
      phone_number: u.phone_number,
      nationality: u.nationality,
      created_at: u.created_at,
      sessions: u._count.sessions,
      kyc_verifications: u._count.kyc_verifications,
      subscriptions: u._count.subscriptions,
      exchange_connections: u._count.exchange_connections,
      payment_history: u._count.payment_history,
      signals: u._count.signals,
      strategies: u._count.strategies,
    }));

    const scored = rows.map((u) => ({ u, score: scoreOf(u), bucket: bucketOf(u) }));

    const BUCKET_ORDER = [
      'Completed (fully onboarded)',
      'Connecting exchange',
      'Paid / acknowledged plan',
      'KYC submitted',
      'Personal info filled',
      'Logged in but no further action',
      'Ghost (signed up, never returned)',
      'Test / Internal',
    ];

    const generatedAt = new Date().toISOString();
    const totalUsers = scored.length;
    const verifiedNow = scored.filter((s) => s.u.email_verified).length;
    const hasSession = scored.filter((s) => s.u.sessions > 0).length;
    const backfillCandidates = scored.filter((s) => !s.u.email_verified && s.u.sessions > 0).length;
    const ghosts = scored.filter((s) => s.bucket === 'Ghost (signed up, never returned)').length;
    const completed = scored.filter((s) => s.u.onboarding_state === 'COMPLETED').length;
    const kycApproved = scored.filter((s) => s.u.kyc_status === 'approved').length;
    const paidTier = scored.filter((s) => s.u.current_tier !== 'FREE').length;

    let md = `# Quantiva — User Authenticity Report\n\n`;
    md += `_Generated: ${generatedAt}_\n\n`;

    md += `## Headline numbers\n\n`;
    md += `| Metric | Count |\n|---|---|\n`;
    md += `| Total users | ${totalUsers} |\n`;
    md += `| Currently \`email_verified = true\` | ${verifiedNow} |\n`;
    md += `| Has logged in at least once (sessions > 0) | ${hasSession} |\n`;
    md += `| **Backfill candidates** (unverified + has session — provably authentic) | **${backfillCandidates}** |\n`;
    md += `| Ghost rows (signed up, no session, no profile) | ${ghosts} |\n`;
    md += `| Completed full onboarding | ${completed} |\n`;
    md += `| KYC approved | ${kycApproved} |\n`;
    md += `| On a paid tier | ${paidTier} |\n\n`;

    md += `## Authenticity scoring\n\n`;
    md += `Each user's score sums these signals:\n\n`;
    md += `| Signal | Points |\n|---|---|\n`;
    md += `| Has at least one session (logged in via 2FA) | +3 |\n`;
    md += `| \`full_name\` set | +1 |\n`;
    md += `| \`phone_number\` set | +1 |\n`;
    md += `| Onboarding past \`SIGNED_UP\` | +2 |\n`;
    md += `| Submitted KYC docs | +3 |\n`;
    md += `| KYC approved | +2 |\n`;
    md += `| Has exchange connection | +3 |\n`;
    md += `| Has subscription record | +2 |\n`;
    md += `| Has payment history | +3 |\n`;
    md += `| On a paid tier | +2 |\n`;
    md += `| Onboarding \`COMPLETED\` | +3 |\n\n`;
    md += `Max possible: 25. Anything ≥ 10 is a clearly engaged real user.\n\n`;

    for (const bucket of BUCKET_ORDER) {
      const inBucket = scored.filter((s) => s.bucket === bucket);
      inBucket.sort((a, b) => b.score - a.score);
      md += `## ${bucket} (${inBucket.length})\n\n`;
      if (inBucket.length === 0) {
        md += `_No users in this bucket._\n\n`;
        continue;
      }
      md += tableHeader();
      for (const { u, score } of inBucket) md += tableRow(u, score) + '\n';
      md += '\n';
    }

    md += `## How to use this report\n\n`;
    md += `- **Safe to broadcast email to:** anyone with a score ≥ 5 OR already in \`email_verified = true\`. These are provably authentic.\n`;
    md += `- **Should be backfilled:** the ${backfillCandidates} users marked \`Verified = —\` who have at least 1 session. Single SQL: \`UPDATE users SET email_verified = true WHERE email_verified = false AND user_id IN (SELECT DISTINCT user_id FROM user_sessions);\`\n`;
    md += `- **Leave alone:** anything in the "Ghost" bucket. No sessions, no profile — could be typos, bots, or abandoned signups. They'll auto-verify if they ever log in.\n`;
    md += `- **Don't broadcast to test/internal accounts:** the "Test / Internal" bucket is filtered out from real marketing audiences.\n`;

    fs.writeFileSync(outPath, md, 'utf-8');
    console.log(`✓ Wrote report to: ${outPath}`);
    console.log(`  Total: ${totalUsers}`);
    console.log(`  Verified now: ${verifiedNow}`);
    console.log(`  Backfill candidates: ${backfillCandidates}`);
    console.log(`  Ghosts: ${ghosts}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
