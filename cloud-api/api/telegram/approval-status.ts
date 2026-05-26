/**
 * API Route: GET /api/telegram/approval/[id]
 *
 * AG polls this after requesting approval to check current status.
 *
 * Auth:    Bearer CRON_SECRET
 * Returns: { status: 'pending'|'approved'|'rejected', message, createdAt, resolvedAt? }
 *
 * Usage from AG chat (bash):
 *   STATUS=$(curl -s \
 *     -H "Authorization: Bearer $CRON_SECRET" \
 *     "https://app.collegeelysee.com/api/telegram/approval/$ID" \
 *     | jq -r '.status')
 *   if [ "$STATUS" = "approved" ]; then git push; fi
 *
 * §13.1 | GENIOS_INDEX.md
 */

import { NextRequest, NextResponse } from 'next/server';
import { getPending }                from '@/lib/telegram/pending';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  // ── Auth ──────────────────────────────────────────────────────────────────
  const bearer = req.headers.get('authorization') ?? '';
  if (bearer !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json(
      { error: 'Unauthorized — CRON_SECRET required' },
      { status: 401 }
    );
  }

  // ── Resolve params (Next.js 15 async params) ──────────────────────────────
  const { id } = await params;
  if (!id) {
    return NextResponse.json({ error: '`id` path param is required' }, { status: 400 });
  }

  // ── Fetch from Firestore ──────────────────────────────────────────────────
  const item = await getPending(id);
  if (!item) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  return NextResponse.json({
    status:     item.status,
    message:    item.message,
    createdAt:  item.createdAt,
    resolvedAt: item.resolvedAt ?? null,
  });
}
