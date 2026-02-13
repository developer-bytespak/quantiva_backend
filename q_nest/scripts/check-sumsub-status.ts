/**
 * Quick script to check Sumsub applicant status and rejection details.
 * Usage: npx ts-node scripts/check-sumsub-status.ts
 */
import * as crypto from 'crypto';
import axios from 'axios';
import * as dotenv from 'dotenv';

dotenv.config();

const APP_TOKEN = process.env.SUMSUB_APP_TOKEN;
const SECRET_KEY = process.env.SUMSUB_SECRET_KEY;
const BASE_URL = process.env.SUMSUB_BASE_URL || 'https://api.sumsub.com';
const APPLICANT_ID = '698fae3af50bd2b543d0307a';

function generateSignature(ts: number, method: string, path: string, body: string = ''): string {
  const hmac = crypto.createHmac('sha256', SECRET_KEY!);
  hmac.update(ts + method + path + body);
  return hmac.digest('hex');
}

async function makeRequest(method: string, path: string) {
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
  console.log('=== Fetching Sumsub Applicant Status ===\n');

  // 1. Get applicant info
  const applicant = await makeRequest('GET', `/resources/applicants/${APPLICANT_ID}/one`);
  console.log('Review Status:', applicant.review?.reviewStatus);
  console.log('Review Answer:', applicant.review?.reviewResult?.reviewAnswer);
  console.log('Reject Labels:', applicant.review?.reviewResult?.rejectLabels);
  console.log('Reject Type:', applicant.review?.reviewResult?.reviewRejectType);
  console.log('Moderation Comment:', applicant.review?.reviewResult?.moderationComment);
  console.log('Client Comment:', applicant.review?.reviewResult?.clientComment);
  console.log('\nFull Review Result:', JSON.stringify(applicant.review, null, 2));

  // 2. Get required docs status
  console.log('\n=== Required Docs Status ===\n');
  try {
    const docsStatus = await makeRequest('GET', `/resources/applicants/${APPLICANT_ID}/requiredIdDocsStatus`);
    console.log(JSON.stringify(docsStatus, null, 2));
  } catch (e: any) {
    console.log('Could not fetch docs status:', e.response?.data || e.message);
  }
}

main().catch(console.error);
