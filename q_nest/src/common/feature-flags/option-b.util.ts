/**
 * Option B feature flag — controls whether a user sees the expanded stock universe (~6,700 stocks)
 * or the original S&P 500-only view.
 *
 * Controlled by .env:
 *   - OPTION_B_GLOBAL_ENABLED=true   → everyone sees Option B
 *   - OPTION_B_ALLOWED_EMAILS=a@x.com,b@y.com  → only listed emails see Option B
 *
 * When neither is set / matched, returns false (legacy S&P 500 view).
 */
export function isOptionBEnabled(userEmail?: string | null): boolean {
  if (process.env.OPTION_B_GLOBAL_ENABLED === 'true') return true;
  if (!userEmail) return false;

  const allowed = (process.env.OPTION_B_ALLOWED_EMAILS || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);

  return allowed.includes(userEmail.toLowerCase());
}
