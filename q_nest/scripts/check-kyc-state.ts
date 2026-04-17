/**
 * Quick diagnostic: dump the KYC-related state for a given email.
 * Shows both the `users` row and any `kyc_verifications` rows.
 *
 * Usage:
 *   npx ts-node scripts/check-kyc-state.ts <email>
 */

import * as dotenv from "dotenv";
import { PrismaClient } from "@prisma/client";

dotenv.config();

async function main() {
  const email = process.argv[2];
  if (!email) {
    console.error("Usage: npx ts-node scripts/check-kyc-state.ts <email>");
    process.exit(1);
  }

  const prisma = new PrismaClient();
  try {
    const user = await prisma.users.findUnique({
      where: { email },
      select: {
        user_id: true,
        email: true,
        kyc_status: true,
        created_at: true,
      },
    });

    if (!user) {
      console.log(`No user found with email: ${email}`);
      return;
    }

    console.log("\n── users ──");
    console.log(`  user_id    : ${user.user_id}`);
    console.log(`  email      : ${user.email}`);
    console.log(`  kyc_status : ${user.kyc_status}`);
    console.log(`  created_at : ${user.created_at.toISOString()}`);

    const verifications = await prisma.kyc_verifications.findMany({
      where: { user_id: user.user_id },
      orderBy: { created_at: "desc" },
    });

    console.log(`\n── kyc_verifications (${verifications.length}) ──`);
    if (verifications.length === 0) {
      console.log("  (none)");
    } else {
      verifications.forEach((v, i) => {
        console.log(`  [${i + 1}]`);
        console.log(`    kyc_id              : ${v.kyc_id}`);
        console.log(`    status              : ${v.status}`);
        console.log(`    review_reject_type  : ${v.review_reject_type ?? "(null)"}`);
        console.log(`    sumsub_applicant_id : ${v.sumsub_applicant_id ?? "(null)"}`);
        console.log(`    sumsub_review_status: ${v.sumsub_review_status ?? "(null)"}`);
        console.log(`    created_at          : ${v.created_at.toISOString()}`);
      });
    }

    const kycIds = verifications.map((v) => v.kyc_id);
    if (kycIds.length) {
      const [docCount, faceCount] = await Promise.all([
        prisma.kyc_documents.count({ where: { kyc_id: { in: kycIds } } }),
        prisma.kyc_face_matches.count({ where: { kyc_id: { in: kycIds } } }),
      ]);
      console.log(`\n── related ──`);
      console.log(`  kyc_documents   : ${docCount}`);
      console.log(`  kyc_face_matches: ${faceCount}`);
    }
    console.log("");
  } finally {
    await prisma.$disconnect();
  }
}

main();
