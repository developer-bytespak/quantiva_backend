/**
 * Reset a SumSub applicant (clears submissions so they can re-verify).
 * Usage: npx ts-node scripts/reset-sumsub-applicant.ts [applicantId]
 * Example: npx ts-node scripts/reset-sumsub-applicant.ts 699c96ad4de18e8a0218ca84
 */
import * as crypto from 'crypto';
import axios from 'axios';
import * as dotenv from 'dotenv';

dotenv.config();

const APP_TOKEN = process.env.SUMSUB_APP_TOKEN;
const SECRET_KEY = process.env.SUMSUB_SECRET_KEY;
const BASE_URL = process.env.SUMSUB_BASE_URL || 'https://api.sumsub.com';

const APPLICANT_ID = process.argv[2] || '699c96ad4de18e8a0218ca84';

function generateSignature(ts: number, method: string, path: string, body: string = ''): string {
  const hmac = crypto.createHmac('sha256', SECRET_KEY!);
  hmac.update(ts + method + path + body);
  return hmac.digest('hex');
}

async function resetApplicant(applicantId: string) {
  const method = 'POST';
  const path = `/resources/applicants/${applicantId}/reset`;
  const ts = Math.floor(Date.now() / 1000);
  const sig = generateSignature(ts, method, path);

  const response = await axios({
    method,
    url: `${BASE_URL}${path}`,
    headers: {
      'X-App-Token': APP_TOKEN,
      'X-App-Access-Ts': ts.toString(),
      'X-App-Access-Sig': sig,
      'Accept': 'application/json',
    },
  });

  return response.data;
}

async function main() {
  if (!APP_TOKEN || !SECRET_KEY) {
    console.error('Missing SUMSUB_APP_TOKEN or SUMSUB_SECRET_KEY in .env');
    process.exit(1);
  }

  console.log(`Resetting SumSub applicant: ${APPLICANT_ID}\n`);

  try {
    const result = await resetApplicant(APPLICANT_ID);
    console.log('Reset successful.');
    console.log('Response:', result);
  } catch (e: any) {
    console.error('Reset failed:', e.response?.data || e.message);
    process.exit(1);
  }
}

main();
