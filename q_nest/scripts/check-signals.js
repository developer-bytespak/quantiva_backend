const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
p.options_signals_ai.findMany({ orderBy: { created_at: 'desc' }, take: 5 })
  .then(rows => {
    if (!rows.length) { console.log('No rows found in options_signals_ai'); return; }
    rows.forEach(r => {
      console.log('---');
      console.log('underlying:', r.underlying, '| strategy:', r.strategy, '| direction:', r.direction);
      console.log('score:', r.score.toString(), '| confidence:', r.confidence.toString());
      console.log('legs:', JSON.stringify(r.legs));
      console.log('expires_at:', r.expires_at, '| created_at:', r.created_at);
    });
  })
  .catch(e => console.error(e.message))
  .finally(() => p.$disconnect());
