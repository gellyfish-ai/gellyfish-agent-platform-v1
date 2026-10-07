import { FastifyInstance } from 'fastify';
import {
  isDiagnosticsEnabled,
  getRecentApprovalDiagnostics,
  getApprovalDiagnosticById,
} from '../diagnostics/approvals-buffer.js';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

export async function diagnosticsRoutes(server: FastifyInstance) {
  // GET /api/diagnostics/approvals/recent?limit=20
  server.get<{ Querystring: { limit?: string } }>(
    '/diagnostics/approvals/recent',
    async (req, reply) => {
      if (!isDiagnosticsEnabled()) {
        return reply.status(404).send({ error: 'diagnostics disabled' });
      }
      const parsed = req.query.limit !== undefined ? parseInt(req.query.limit, 10) : DEFAULT_LIMIT;
      const limit = Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, MAX_LIMIT) : DEFAULT_LIMIT;
      return { entries: getRecentApprovalDiagnostics(limit) };
    },
  );

  // GET /api/diagnostics/approvals/:id
  server.get<{ Params: { id: string } }>(
    '/diagnostics/approvals/:id',
    async (req, reply) => {
      if (!isDiagnosticsEnabled()) {
        return reply.status(404).send({ error: 'diagnostics disabled' });
      }
      const entry = getApprovalDiagnosticById(req.params.id);
      if (!entry) {
        return reply.status(404).send({ error: 'not found' });
      }
      return entry;
    },
  );
}
