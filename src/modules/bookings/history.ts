import type pg from 'pg';

/** Who changed a booking, and the booking's history log. */

type C = pg.PoolClient;

export type Actor = { type: 'staff' | 'customer' | 'system' | 'stripe'; id?: string | null };

export async function logEvent(
  c: C, bookingId: string, actor: Actor, action: string,
  o: { from?: string | null; to?: string | null; reason?: string | null; meta?: unknown } = {},
) {
  await c.query(
    `INSERT INTO booking_events(booking_id, actor_type, actor_id, action, from_value, to_value, reason, meta)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [bookingId, actor.type, actor.id ?? null, action, o.from ?? null, o.to ?? null, o.reason ?? null, o.meta ? JSON.stringify(o.meta) : null],
  );
}

/** The staff member making this request, as recorded in booking history. */
export const actorOf = (req: any) => ({ type: 'staff' as const, id: req.user.sub as string });
