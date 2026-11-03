import type { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import { z } from 'zod';
import { putPublic } from '../../lib/storage.js';
import { pool } from '../../core/db.js';
import { badRequest } from '../../core/errors.js';
import { audit, sniffImage } from '../../core/util.js';

export function uploadRoutes(app: FastifyInstance) {
  /** Single image for events and offers. Same validation as vehicle images; returns the public URL to store on the record. */
  app.post('/uploads/:kind', async (req, reply) => {
    const { kind } = z.object({ kind: z.enum(['events', 'offers', 'addons']) }).parse(req.params);
    const part = await req.file();
    if (!part) throw badRequest('No file received', 'no_file');
    const buf = await part.toBuffer();
    if (part.file.truncated) throw badRequest('File is larger than 8 MB', 'file_too_large');
    const type = sniffImage(buf);
    if (!type) throw badRequest('Only JPEG, PNG or WebP images are accepted', 'invalid_image');
    const key = `${kind}/${crypto.randomUUID()}.${type.ext}`;
    const url = await putPublic(key, buf, type.mime);
    await audit(pool, req.user.sub, 'upload', key, 'create');
    return reply.status(201).send({ url });
  });
}
