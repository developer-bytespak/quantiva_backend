/**
 * Dump all users grouped by onboarding-funnel stage to a markdown file.
 *
 * Usage:
 *   npx ts-node scripts/export-users-onboarding.ts [output-path]
 *
 * Default output path: ./users-onboarding-report.md
 */

import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";
import { PrismaClient } from "@prisma/client";
import { OnboardingState } from "../src/modules/onboarding-emails/types";

dotenv.config();

type UserRow = {
  user_id: string;
  email: string;
  username: string;
  full_name: string | null;
  phone_number: string | null;
  nationality: string | null;
  gender: string | null;
  dob: Date | null;
  profile_pic_url: string | null;
  email_verified: boolean;
  two_factor_enabled: boolean;
  kyc_status: string;
  current_tier: string;
  onboarding_state: OnboardingState;
  stripe_customer_id: string | null;
  stripe_connect_account_id: string | null;
  binance_deposit_address: string | null;
  fcm_token: string | null;
  onboarding_emails_opted_out: boolean;
  created_at: Date;
  updated_at: Date | null;
};

const BUCKETS: { title: string; states: OnboardingState[] }[] = [
  { title: "Signup Only", states: [OnboardingState.SIGNED_UP] },
  { title: "Personal Info Completed", states: [OnboardingState.PERSONAL_INFO] },
  {
    title: "KYC Done",
    states: [
      OnboardingState.KYC,
      OnboardingState.PAID,
      OnboardingState.CONNECT_EXCHANGE,
    ],
  },
  { title: "Full Onboarding Completed", states: [OnboardingState.COMPLETED] },
];

function fmt(d: Date | null): string {
  return d ? d.toISOString() : "—";
}

function esc(v: string | null | undefined): string {
  if (v === null || v === undefined || v === "") return "—";
  return v.replace(/\|/g, "\\|");
}

function yn(b: boolean): string {
  return b ? "yes" : "no";
}

function tableFor(users: UserRow[]): string {
  if (users.length === 0) return "_No users in this bucket._\n";
  const header =
    "| # | Email | Username | Full Name | Phone | Nationality | Gender | DOB | Profile Pic | Email Verified | 2FA | KYC | Tier | State | Stripe Customer | Stripe Connect | Binance Deposit | FCM Token | Emails Opted Out | Created | Updated | user_id |\n" +
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|\n";
  const rows = users
    .map((u, i) => {
      return `| ${i + 1} | ${esc(u.email)} | ${esc(u.username)} | ${esc(u.full_name)} | ${esc(u.phone_number)} | ${esc(u.nationality)} | ${esc(u.gender)} | ${u.dob ? u.dob.toISOString().slice(0, 10) : "—"} | ${esc(u.profile_pic_url)} | ${yn(u.email_verified)} | ${yn(u.two_factor_enabled)} | ${esc(u.kyc_status)} | ${esc(u.current_tier)} | ${esc(u.onboarding_state)} | ${esc(u.stripe_customer_id)} | ${esc(u.stripe_connect_account_id)} | ${esc(u.binance_deposit_address)} | ${esc(u.fcm_token)} | ${yn(u.onboarding_emails_opted_out)} | ${fmt(u.created_at)} | ${fmt(u.updated_at)} | ${u.user_id} |`;
    })
    .join("\n");
  return header + rows + "\n";
}

async function main() {
  const outArg = process.argv[2];
  const outPath = outArg
    ? path.resolve(outArg)
    : path.resolve(process.cwd(), "users-onboarding-report.md");

  const prisma = new PrismaClient();
  try {
    const users = (await prisma.users.findMany({
      select: {
        user_id: true,
        email: true,
        username: true,
        full_name: true,
        phone_number: true,
        nationality: true,
        gender: true,
        dob: true,
        profile_pic_url: true,
        email_verified: true,
        two_factor_enabled: true,
        kyc_status: true,
        current_tier: true,
        onboarding_state: true,
        stripe_customer_id: true,
        stripe_connect_account_id: true,
        binance_deposit_address: true,
        fcm_token: true,
        onboarding_emails_opted_out: true,
        created_at: true,
        updated_at: true,
      },
      orderBy: { created_at: "asc" },
    })) as unknown as UserRow[];

    const byBucket = BUCKETS.map((b) => ({
      ...b,
      users: users.filter((u) => b.states.includes(u.onboarding_state)),
    }));

    const recognizedStates = new Set(BUCKETS.flatMap((b) => b.states));
    const uncategorized = users.filter(
      (u) => !recognizedStates.has(u.onboarding_state),
    );

    const generatedAt = new Date().toISOString();

    let md = `# Quantiva — Users Onboarding Funnel Report\n\n`;
    md += `_Generated: ${generatedAt}_\n\n`;
    md += `**Total users:** ${users.length}\n\n`;

    md += `## Summary\n\n`;
    md += `| Bucket | Onboarding States | User Count | % of Total |\n`;
    md += `|---|---|---|---|\n`;
    for (const b of byBucket) {
      const pct =
        users.length === 0
          ? "0.00%"
          : ((b.users.length / users.length) * 100).toFixed(2) + "%";
      md += `| ${b.title} | ${b.states.join(", ")} | ${b.users.length} | ${pct} |\n`;
    }
    if (uncategorized.length > 0) {
      const pct = ((uncategorized.length / users.length) * 100).toFixed(2) + "%";
      md += `| _Uncategorized_ | other | ${uncategorized.length} | ${pct} |\n`;
    }
    md += `\n`;

    for (const b of byBucket) {
      md += `## ${b.title} (${b.users.length})\n\n`;
      md += `States: ${b.states.join(", ")}\n\n`;
      md += tableFor(b.users);
      md += `\n`;
    }

    if (uncategorized.length > 0) {
      md += `## Uncategorized (${uncategorized.length})\n\n`;
      md += tableFor(uncategorized);
      md += `\n`;
    }

    fs.writeFileSync(outPath, md, "utf-8");
    console.log(`Wrote report to: ${outPath}`);
    console.log(`Total users: ${users.length}`);
    for (const b of byBucket) {
      console.log(`  ${b.title}: ${b.users.length}`);
    }
    if (uncategorized.length > 0) {
      console.log(`  Uncategorized: ${uncategorized.length}`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
