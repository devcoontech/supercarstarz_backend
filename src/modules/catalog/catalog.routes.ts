import type { FastifyInstance } from 'fastify';
import { vehicleRoutes } from '../vehicles/vehicles.routes.js';
import { uploadRoutes } from './uploads.routes.js';
import { eventTypeRoutes } from '../events/event-types.routes.js';
import { pricingRuleRoutes } from '../pricing/pricing-rules.routes.js';
import { addonRoutes } from '../addons/addons.routes.js';

export async function adminCatalogRoutes(app: FastifyInstance) {
  app.addHook('onRequest', app.staffOnly);

  // Feature route groups share this instance, so the hooks above apply to all of them.
  vehicleRoutes(app);
  uploadRoutes(app);
  eventTypeRoutes(app);
  pricingRuleRoutes(app);
  addonRoutes(app);
}
