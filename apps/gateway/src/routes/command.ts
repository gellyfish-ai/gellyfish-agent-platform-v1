import { FastifyInstance } from 'fastify';

interface CommandRequest {
  source: 'siri' | 'telegram' | 'whatsapp' | 'voice' | 'api';
  user_id: string;
  command: string;
  context?: Record<string, unknown>;
}

interface CommandResponse {
  id: string;
  status: 'received' | 'processing' | 'completed' | 'failed';
  message?: string;
}

export async function commandRoutes(server: FastifyInstance) {
  server.post<{ Body: CommandRequest }>('/command', async (request, reply) => {
    const { source, user_id, command, context } = request.body;

    // TODO: Validate request
    // TODO: Authenticate user
    // TODO: Forward to core agent

    const id = crypto.randomUUID();

    server.log.info({ id, source, user_id, command }, 'Command received');

    // TODO: Async processing - for now just acknowledge
    const response: CommandResponse = {
      id,
      status: 'received',
      message: 'Command queued for processing',
    };

    return reply.status(202).send(response);
  });

  server.get<{ Params: { id: string } }>('/command/:id', async (request, reply) => {
    const { id } = request.params;

    // TODO: Look up command status from storage
    return reply.status(404).send({ error: 'Command not found', id });
  });
}
