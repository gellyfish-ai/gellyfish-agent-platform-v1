import { FastifyInstance } from 'fastify';
import { getAllRiskLevels, getRiskLevelsForMcp, setRiskLevel, type RiskLevel } from '../db/risk-levels.js';

const VALID_LEVELS: RiskLevel[] = ['none', 'notify', 'approve'];

export async function riskLevelsRoutes(server: FastifyInstance) {
  // GET /api/tool-risk-levels — list all configured risk levels
  server.get('/tool-risk-levels', async () => {
    return { levels: getAllRiskLevels() };
  });

  // GET /api/tool-risk-levels/:mcpName — list for one MCP
  server.get<{ Params: { mcpName: string } }>('/tool-risk-levels/:mcpName', async (req) => {
    return { levels: getRiskLevelsForMcp(req.params.mcpName) };
  });

  // PUT /api/tool-risk-levels — upsert one entry
  server.put<{
    Body: { mcpName: string; toolName: string; riskLevel: string };
  }>('/tool-risk-levels', async (req, reply) => {
    const { mcpName, toolName, riskLevel } = req.body;
    if (!mcpName || !toolName) {
      return reply.status(400).send({ error: 'mcpName and toolName are required' });
    }
    if (!VALID_LEVELS.includes(riskLevel as RiskLevel)) {
      return reply.status(400).send({ error: `riskLevel must be one of: ${VALID_LEVELS.join(', ')}` });
    }
    setRiskLevel(mcpName, toolName, riskLevel as RiskLevel);
    return { ok: true, mcpName, toolName, riskLevel };
  });
}
