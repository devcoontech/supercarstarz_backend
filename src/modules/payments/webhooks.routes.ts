import type { FastifyInstance } from 'fastify';
import Stripe from 'stripe';
import { badRequest } from '../../core/errors.js';
import { getSecret } from '../../core/settings.js';
import { handleStripeEvent } from './payments.js';

export async function webhookRoutes(app: FastifyInstance) {
  // Stripe signs the exact bytes it sent, so keep the body as a Buffer inside this scope only.
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

  app.post('/stripe', async (req, reply) => {
    const secret = await getSecret('stripe.webhookSecret');
    if (!secret) return reply.status(503).send({ error: { code: 'stripe_not_configured', message: 'Webhook secret not configured' } });
    const sig = req.headers['stripe-signature'];
    if (typeof sig !== 'string') throw badRequest('Missing signature', 'bad_signature');
    let event: Stripe.Event;
    try {
      event = Stripe.webhooks.constructEvent(req.body as Buffer, sig, secret);
    } catch {
      throw badRequest('Invalid signature', 'bad_signature');
    }
    const res = await handleStripeEvent(event);
    return { received: true, ...res };
  });
}
