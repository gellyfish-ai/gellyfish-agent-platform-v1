import type { PMEvent } from '../pm-client.js';

export interface ManagedProcess {
  sessionId: string;
  pmSessionId: string;
  profileId?: string;
  agentId?: string;
  conversationId?: string;
  pid: number | null;
  alive: boolean;
  sockets: Set<unknown>;
  pendingPermissions: Map<string, { toolName: string; input: unknown }>;
  taskEventListeners: Map<string, (event: PMEvent) => void>;
  processing: boolean;
  lastActivityAt: Date | null;
  lastEventType: string | null;
  staleNotified: boolean;
  apiErrorCount: number;
  lastApiError: string | null;
  lastStdinAt: Date | null;
  pendingTaskContext: { taskId: string; agentName: string } | null;
  lastStderr: string | null;
  skipMcp: boolean;
  pendingApprovals: Map<string, string>; // approvalId -> requestId
}

export interface SendResult {
  sessionId: string;
  managed: ManagedProcess;
  delivered: boolean;
  spawned: boolean;
  error?: string;
  sessionMissing?: { sessionId: string; conversationId?: string; agentName?: string };
}
