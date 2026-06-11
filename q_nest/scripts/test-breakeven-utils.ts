/* Quick logic check for the new shared utils. Run:
 *   npx ts-node scripts/test-breakeven-utils.ts
 */
import {
  computeBreakevens,
  type PopLeg,
} from '../src/modules/options/services/alpaca/pop-engine';
import {
  estimateRiskReward,
  formatUsd,
} from '../src/modules/options/services/alpaca/risk-reward';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = '') {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}  ${detail}`);
  }
}

// The client's NVDA strangle: spot 203.40, call 215 / put 192.50. With a
// realistic live debit of $5.70 (vs the old hardcoded 4% = $8.14):
const strangleLegs: PopLeg[] = [
  { side: 'BUY', type: 'CALL', strike: 215, ratio: 1 },
  { side: 'BUY', type: 'PUT', strike: 192.5, ratio: 1 },
];
const be = computeBreakevens('long_strangle', strangleLegs, 5.7, 203.4);
check('strangle BE low 186.80', !!be && Math.abs(be.breakevenLow! - 186.8) < 1e-9, JSON.stringify(be));
check('strangle BE high 220.70', !!be && Math.abs(be.breakevenHigh! - 220.7) < 1e-9, JSON.stringify(be));
check(
  'strangle required move ~8.2% (min of both sides)',
  !!be && Math.abs(be.requiredMovePct! - (203.4 - 186.8) / 203.4) < 1e-9,
  JSON.stringify(be),
);

const rr = estimateRiskReward('long_strangle', [215, 192.5], 5.7);
check('strangle target profit 2x debit', !!rr && rr.maxProfit === 11.4 && rr.maxLoss === 5.7, JSON.stringify(rr));

// Long call: K=200, debit 4.5, spot 198 -> BE 204.5, move +3.28%
const lc = computeBreakevens('long_call', [{ side: 'BUY', type: 'CALL', strike: 200, ratio: 1 }], 4.5, 198);
check('long_call BE 204.5', !!lc && lc.breakevenHigh === 204.5 && lc.breakevenLow === null, JSON.stringify(lc));
check('long_call move (204.5-198)/198', !!lc && Math.abs(lc.requiredMovePct! - 6.5 / 198) < 1e-9, JSON.stringify(lc));

// Iron condor (credit −1.5): strikes 180/190/210/220, spot 200.
const icLegs: PopLeg[] = [
  { side: 'BUY', type: 'PUT', strike: 180, ratio: 1 },
  { side: 'SELL', type: 'PUT', strike: 190, ratio: 1 },
  { side: 'SELL', type: 'CALL', strike: 210, ratio: 1 },
  { side: 'BUY', type: 'CALL', strike: 220, ratio: 1 },
];
const ic = computeBreakevens('iron_condor', icLegs, -1.5, 200);
check('condor band 188.5..211.5, move null', !!ic && ic.breakevenLow === 188.5 && ic.breakevenHigh === 211.5 && ic.requiredMovePct === null, JSON.stringify(ic));
const icRr = estimateRiskReward('iron_condor', [180, 190, 210, 220], -1.5);
check('condor profit=credit, loss=wing-credit', !!icRr && icRr.maxProfit === 1.5 && icRr.maxLoss === 8.5, JSON.stringify(icRr));

// Short put already in profit zone: K=195, credit 2, spot 200 -> BE 193, move 0
const sp = computeBreakevens('short_put', [{ side: 'SELL', type: 'PUT', strike: 195, ratio: 1 }], -2, 200);
check('short_put BE 193, move 0', !!sp && sp.breakevenLow === 193 && sp.requiredMovePct === 0, JSON.stringify(sp));

// Direction mismatch -> null (condor quoted as a debit)
check('condor with debit -> null', computeBreakevens('iron_condor', icLegs, 1.5, 200) === null);
check('calendar -> null', computeBreakevens('calendar_spread', strangleLegs, 1, 200) === null);

// formatUsd parity with the Python _fmt_usd tiers
check('formatUsd >=100', formatUsd(1264.4) === '$1,264', formatUsd(1264.4));
check('formatUsd >=1', formatUsd(5.5) === '$5.50', formatUsd(5.5));
check('formatUsd <1', formatUsd(0.045) === '$0.0450', formatUsd(0.045));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
