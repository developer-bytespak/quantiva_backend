/**
 * Test the Option B feature flag utility.
 * Verifies the function reads env vars correctly and handles edge cases.
 *
 * Usage:
 *   npx ts-node scripts/test-option-b-flag.ts
 */

import * as dotenv from 'dotenv';
dotenv.config();

import { isOptionBEnabled } from '../src/common/feature-flags/option-b.util';

function assert(label: string, actual: boolean, expected: boolean) {
  const pass = actual === expected;
  const mark = pass ? '✓' : '✗';
  const color = pass ? '\x1b[32m' : '\x1b[31m';
  const reset = '\x1b[0m';
  console.log(`  ${color}${mark}${reset} ${label.padEnd(50)} actual=${actual}, expected=${expected}`);
  return pass;
}

function snapshot() {
  return {
    allowed: process.env.OPTION_B_ALLOWED_EMAILS,
    global: process.env.OPTION_B_GLOBAL_ENABLED,
  };
}

function reset(snap: ReturnType<typeof snapshot>) {
  if (snap.allowed === undefined) delete process.env.OPTION_B_ALLOWED_EMAILS;
  else process.env.OPTION_B_ALLOWED_EMAILS = snap.allowed;

  if (snap.global === undefined) delete process.env.OPTION_B_GLOBAL_ENABLED;
  else process.env.OPTION_B_GLOBAL_ENABLED = snap.global;
}

async function main() {
  const original = snapshot();
  let allPassed = true;

  console.log('\n=== Reading .env values ===');
  console.log(`  OPTION_B_ALLOWED_EMAILS = "${process.env.OPTION_B_ALLOWED_EMAILS || '(not set)'}"`);
  console.log(`  OPTION_B_GLOBAL_ENABLED = "${process.env.OPTION_B_GLOBAL_ENABLED || '(not set)'}"`);

  console.log('\n=== Test 1: With YOUR current .env settings ===');
  const yourEmail = 'developers@bytesplatform.com';
  const otherEmail = 'random.user@example.com';
  console.log(`  Your email (${yourEmail}) is enabled?     ${isOptionBEnabled(yourEmail)}`);
  console.log(`  Other email (${otherEmail}) is enabled?   ${isOptionBEnabled(otherEmail)}`);
  console.log(`  Anonymous (no email) is enabled?              ${isOptionBEnabled()}`);
  console.log(`  null user is enabled?                         ${isOptionBEnabled(null)}`);

  console.log('\n=== Test 2: Allowlist behavior (forcing env values) ===');
  process.env.OPTION_B_ALLOWED_EMAILS = 'alice@test.com, BOB@test.com ,charlie@test.com';
  delete process.env.OPTION_B_GLOBAL_ENABLED;

  allPassed = assert('alice (lowercase) → allowed', isOptionBEnabled('alice@test.com'), true) && allPassed;
  allPassed = assert('Alice (mixed case) → allowed (case-insensitive)', isOptionBEnabled('Alice@test.com'), true) && allPassed;
  allPassed = assert('bob (with whitespace in env) → allowed', isOptionBEnabled('bob@test.com'), true) && allPassed;
  allPassed = assert('NOT in allowlist → denied', isOptionBEnabled('dave@test.com'), false) && allPassed;
  allPassed = assert('undefined email → denied', isOptionBEnabled(undefined), false) && allPassed;
  allPassed = assert('empty string email → denied', isOptionBEnabled(''), false) && allPassed;

  console.log('\n=== Test 3: GLOBAL_ENABLED overrides everything ===');
  process.env.OPTION_B_GLOBAL_ENABLED = 'true';
  process.env.OPTION_B_ALLOWED_EMAILS = '';

  allPassed = assert('any email → allowed (global on)', isOptionBEnabled('anyone@anywhere.com'), true) && allPassed;
  allPassed = assert('undefined → allowed (global on)', isOptionBEnabled(undefined), true) && allPassed;

  console.log('\n=== Test 4: GLOBAL_ENABLED=false acts like off ===');
  process.env.OPTION_B_GLOBAL_ENABLED = 'false';
  process.env.OPTION_B_ALLOWED_EMAILS = 'alice@test.com';

  allPassed = assert('alice → still allowed via allowlist', isOptionBEnabled('alice@test.com'), true) && allPassed;
  allPassed = assert('dave → still denied (global=false doesn\'t force enable)', isOptionBEnabled('dave@test.com'), false) && allPassed;

  console.log('\n=== Test 5: Empty allowlist with no global ===');
  delete process.env.OPTION_B_GLOBAL_ENABLED;
  process.env.OPTION_B_ALLOWED_EMAILS = '';

  allPassed = assert('anyone → denied (empty allowlist)', isOptionBEnabled('alice@test.com'), false) && allPassed;

  reset(original);

  console.log('\n========================================');
  if (allPassed) {
    console.log('  ✓ ALL TESTS PASSED');
  } else {
    console.log('  ✗ SOME TESTS FAILED — review above');
  }
  console.log('========================================\n');

  process.exit(allPassed ? 0 : 1);
}

main();
