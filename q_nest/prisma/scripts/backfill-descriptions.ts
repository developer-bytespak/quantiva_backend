/**
 * One-shot backfill: populate empty `news_detail.description` fields on
 * general-feed `trending_news` rows.
 *
 * Root cause: the first version of `_fetch_general_news_http` read article
 * body from `post_text` / `description` / `text`, but LunarCrush's
 * topic/cryptocurrency/news endpoint actually returns body text under
 * `post_description`. All rows created before the fix have empty
 * descriptions. This script fetches the current LunarCrush feed once,
 * maps URL -> description, and patches matching DB rows.
 *
 * Usage (from q_nest root):
 *   npx ts-node -T prisma/scripts/backfill-descriptions.ts
 *
 * Costs 1 LunarCrush call (goes through the quota gate on the Python side
 * only if you route it there; this script hits LunarCrush directly).
 */
import { PrismaClient } from '@prisma/client';
import * as https from 'https';

const LC_BASE = 'https://lunarcrush.com/api4/public/topic/cryptocurrency/news/v1';

function fetchLunarCrushFeed(apiKey: string): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      LC_BASE,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          Accept: 'application/json',
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString();
          if (res.statusCode !== 200) {
            return reject(
              new Error(`LunarCrush HTTP ${res.statusCode}: ${body.slice(0, 200)}`),
            );
          }
          try {
            const json = JSON.parse(body);
            const articles = Array.isArray(json) ? json : json.data || [];
            resolve(articles);
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

async function main(): Promise<void> {
  const apiKey = process.env.LUNARCRUSH_API_KEY;
  if (!apiKey) {
    console.error('LUNARCRUSH_API_KEY env var is required');
    process.exit(1);
  }

  console.log('Fetching current LunarCrush topic/cryptocurrency feed...');
  const articles = await fetchLunarCrushFeed(apiKey);
  console.log(`  got ${articles.length} articles`);

  // Build url -> description map
  const urlToDescription = new Map<string, string>();
  for (const a of articles) {
    const url = a.post_link || a.url || a.link;
    const desc =
      a.post_description || a.post_text || a.description || a.text || '';
    if (url && desc) {
      urlToDescription.set(url, desc);
    }
  }
  console.log(`  ${urlToDescription.size} articles have a description`);

  const prisma = new PrismaClient();
  try {
    // Pull all general-feed rows that currently have empty/missing description.
    const rows = await prisma.trending_news.findMany({
      where: {
        article_url: { not: '' },
      },
      select: {
        poll_timestamp: true,
        asset_id: true,
        article_url: true,
        news_detail: true,
        metadata: true,
      },
      take: 1000,
    });

    let updated = 0;
    let skippedNotGeneral = 0;
    let skippedNoMatch = 0;
    let skippedAlreadyHasDesc = 0;

    for (const row of rows) {
      const meta = (row.metadata ?? {}) as Record<string, any>;
      if (meta.general_feed !== true) {
        skippedNotGeneral++;
        continue;
      }

      const detail = (row.news_detail ?? {}) as Record<string, any>;
      const currentDesc = String(detail.description || '').trim();
      if (currentDesc.length > 0) {
        skippedAlreadyHasDesc++;
        continue;
      }

      const url = row.article_url;
      if (!url) {
        skippedNoMatch++;
        continue;
      }

      const freshDesc = urlToDescription.get(url);
      if (!freshDesc) {
        skippedNoMatch++;
        continue;
      }

      await prisma.trending_news.update({
        where: {
          poll_timestamp_asset_id: {
            poll_timestamp: row.poll_timestamp,
            asset_id: row.asset_id,
          },
        },
        data: {
          news_detail: {
            ...detail,
            description: freshDesc,
          },
        },
      });
      updated++;
    }

    console.log();
    console.log('=== Description backfill summary ===');
    console.log(`  scanned                    : ${rows.length}`);
    console.log(`  updated                    : ${updated}`);
    console.log(`  skipped (not general)      : ${skippedNotGeneral}`);
    console.log(`  skipped (already has desc) : ${skippedAlreadyHasDesc}`);
    console.log(`  skipped (no URL match in feed): ${skippedNoMatch}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
