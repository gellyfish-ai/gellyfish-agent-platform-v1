import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import db, {
  createAgent, getAgent, listAgents, updateAgentState, getAgentForProfile,
  createConversation, getConversation, getAgentConversation,
  updateConversationState, updateConversationSession,
  upsertReaction, removeReaction, getReactions,
  insertSummary, getSummaries,
  storeSessionTaskEvent, getSessionTaskEvents,
  getSetting, setSetting,
} from '../../src/db/index.js';

function seedProfiles() {
  db.prepare(`
    INSERT OR IGNORE INTO profiles (id, name, icon, system_prompt, workspace_dir)
    VALUES (?, ?, ?, '', '')
  `).run('db-test-profile', 'DB Test Profile', '🧪');
  db.prepare(`
    INSERT OR IGNORE INTO profiles (id, name, icon, system_prompt, workspace_dir)
    VALUES (?, ?, ?, '', '')
  `).run('db-test-profile-2', 'DB Test Profile 2', '🔬');
}

describe('Agent CRUD', () => {
  beforeAll(seedProfiles);

  beforeEach(() => {
    db.prepare("DELETE FROM conversations WHERE agent_id IN (SELECT id FROM agents WHERE profile_id LIKE 'db-test-%')").run();
    db.prepare("DELETE FROM agents WHERE profile_id LIKE 'db-test-%'").run();
  });

  it('createAgent creates agent with conversation', () => {
    const agent = createAgent('db-test-profile', 'Test Agent');
    expect(agent.name).toBe('Test Agent');
    expect(agent.state).toBe('idle');
    expect(agent.profile_id).toBe('db-test-profile');

    // Should auto-create conversation
    const conv = getAgentConversation(agent.id);
    expect(conv).toBeDefined();
    expect(conv!.agent_id).toBe(agent.id);
    expect(conv!.state).toBe('cold');
  });

  it('getAgent returns undefined for nonexistent', () => {
    expect(getAgent('nonexistent-id')).toBeUndefined();
  });

  it('listAgents filters by profileId and state', () => {
    createAgent('db-test-profile', 'Agent A');
    createAgent('db-test-profile-2', 'Agent B');

    const all = listAgents();
    expect(all.length).toBeGreaterThanOrEqual(2);

    const filtered = listAgents({ profileId: 'db-test-profile' });
    expect(filtered.every(a => a.profile_id === 'db-test-profile')).toBe(true);

    const idle = listAgents({ state: 'idle' });
    expect(idle.every(a => a.state === 'idle')).toBe(true);
  });

  it('updateAgentState changes state', () => {
    const agent = createAgent('db-test-profile', 'State Test');
    updateAgentState(agent.id, 'working');
    const updated = getAgent(agent.id);
    expect(updated!.state).toBe('working');
  });

  it('getAgentForProfile returns first non-stopped agent', () => {
    const agent = createAgent('db-test-profile', 'Default Agent');
    const found = getAgentForProfile('db-test-profile');
    expect(found).toBeDefined();
    expect(found!.id).toBe(agent.id);
  });
});

describe('Conversation helpers', () => {
  beforeAll(seedProfiles);

  it('updateConversationState transitions state', () => {
    const agent = createAgent('db-test-profile', 'Conv Agent');
    const conv = getAgentConversation(agent.id)!;
    expect(conv.state).toBe('cold');

    updateConversationState(conv.id, 'active');
    const updated = getConversation(conv.id);
    expect(updated!.state).toBe('active');
  });

  it('updateConversationSession sets/clears session_id', () => {
    const agent = createAgent('db-test-profile', 'Session Agent');
    const conv = getAgentConversation(agent.id)!;

    updateConversationSession(conv.id, 'sess-123');
    expect(getConversation(conv.id)!.session_id).toBe('sess-123');

    updateConversationSession(conv.id, null);
    expect(getConversation(conv.id)!.session_id).toBeNull();
  });
});

describe('Reactions', () => {
  beforeEach(() => {
    db.prepare("DELETE FROM message_reactions WHERE session_id = 'test-session'").run();
  });

  it('upsertReaction creates and updates', () => {
    upsertReaction('test-session', 'msg-1', '👍', 'great work');
    const reactions = getReactions('test-session');
    expect(reactions).toHaveLength(1);
    expect(reactions[0].emoji).toBe('👍');
    expect(reactions[0].message_id).toBe('msg-1');

    // Upsert changes emoji
    upsertReaction('test-session', 'msg-1', '🎉', 'great work');
    const updated = getReactions('test-session');
    expect(updated).toHaveLength(1);
    expect(updated[0].emoji).toBe('🎉');
  });

  it('removeReaction deletes reaction', () => {
    upsertReaction('test-session', 'msg-2', '👎');
    expect(getReactions('test-session')).toHaveLength(1);

    removeReaction('test-session', 'msg-2');
    expect(getReactions('test-session')).toHaveLength(0);
  });

  it('getReactions returns empty for no reactions', () => {
    expect(getReactions('nonexistent-session')).toHaveLength(0);
  });
});

describe('Conversation summaries', () => {
  let testConvId: string;

  beforeAll(() => {
    seedProfiles();
    const agent = createAgent('db-test-profile', 'Summary Agent');
    const conv = getAgentConversation(agent.id)!;
    testConvId = conv.id;
  });

  beforeEach(() => {
    db.prepare('DELETE FROM conversation_summaries WHERE conversation_id = ?').run(testConvId);
  });

  it('insertSummary stores and returns summary', () => {
    const summary = insertSummary({
      conversationId: testConvId,
      sessionId: 'sess-abc',
      summary: 'Discussed refactoring the auth middleware',
      startedAt: '2026-03-23T10:00:00Z',
      endedAt: '2026-03-23T12:00:00Z',
      messageCount: 42,
    });
    expect(summary.conversation_id).toBe(testConvId);
    expect(summary.session_id).toBe('sess-abc');
    expect(summary.summary).toBe('Discussed refactoring the auth middleware');
    expect(summary.message_count).toBe(42);
  });

  it('getSummaries returns ordered summaries', () => {
    insertSummary({ conversationId: testConvId, summary: 'First session', messageCount: 10 });
    insertSummary({ conversationId: testConvId, summary: 'Second session', messageCount: 20 });

    const summaries = getSummaries(testConvId);
    expect(summaries).toHaveLength(2);
    expect(summaries[0].summary).toBe('First session');
    expect(summaries[1].summary).toBe('Second session');
  });

  it('getSummaries returns empty for no summaries', () => {
    expect(getSummaries('nonexistent-conv')).toHaveLength(0);
  });
});

describe('Session task events', () => {
  beforeEach(() => {
    db.prepare("DELETE FROM session_task_events WHERE session_id = 'test-ste-session'").run();
  });

  it('storeSessionTaskEvent stores and getSessionTaskEvents retrieves', () => {
    storeSessionTaskEvent('test-ste-session', 'task-x', 'task_update', { state: 'working' });
    storeSessionTaskEvent('test-ste-session', 'task-x', 'task_progress', { event: 'tool_use' });

    const events = getSessionTaskEvents('test-ste-session');
    expect(events).toHaveLength(2);
    expect(events[0].task_id).toBe('task-x');
    expect(events[0].event_type).toBe('task_update');
    expect(JSON.parse(events[0].data).state).toBe('working');
  });
});

describe('Settings', () => {
  it('setSetting and getSetting work', () => {
    setSetting('test_key', 'test_value');
    expect(getSetting('test_key')).toBe('test_value');

    setSetting('test_key', 'updated_value');
    expect(getSetting('test_key')).toBe('updated_value');
  });

  it('getSetting returns undefined for missing key', () => {
    expect(getSetting('nonexistent_key')).toBeUndefined();
  });
});
