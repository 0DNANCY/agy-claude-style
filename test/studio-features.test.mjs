import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchSubagentTree, normalizeChildSubagent } from '../sidecars/panel/lib/subagent-tree.mjs';

test('normalizeChildSubagent classifies Swarm workers and subagents with state', () => {
  const swarmChild = normalizeChildSubagent(
    {
      id: 'child-1',
      state: { runState: 'RUN_STATE_RUNNING' },
      annotations: { title: '@reviewer' },
    },
    {
      stepCount: 7,
      trajectoryMetadata: {
        subagentSpec: { typeName: 'worker', role: 'Swarm Worker (reviewer)' },
        agentScript: { name: 'reviewer' },
      },
    }
  );
  assert.equal(swarmChild.kind, 'swarm');
  assert.equal(swarmChild.title, '@reviewer');
  assert.equal(swarmChild.state, 'running');
  assert.equal(swarmChild.stepCount, 7);

  const subChild = normalizeChildSubagent(
    {
      id: 'child-2',
      state: { runState: 'RUN_STATE_IDLE' },
    },
    {
      stepCount: 4,
      status: 'COMPLETED',
      trajectoryMetadata: {
        subagentSpec: { typeName: 'research', role: 'Codebase Researcher' },
      },
    }
  );
  assert.equal(subChild.kind, 'subagent');
  assert.equal(subChild.title, 'Codebase Researcher');
  assert.equal(subChild.state, 'done');
});

test('fetchSubagentTree builds parent -> subagent tree from LS RPCs', async () => {
  const calls = [];
  const fakeFetch = async (url, init) => {
    const body = JSON.parse(init.body || '{}');
    calls.push({ url, headers: init.headers, body });
    if (url.endsWith('/product.v1.ConversationService/ListConversations') && body.parentConversationId === 'conv-main') {
      return {
        ok: true,
        async json() {
          return {
            conversations: [
              { id: 'sub-1', state: { runState: 'RUN_STATE_RUNNING' }, annotations: { title: 'Helper' } },
            ],
          };
        },
      };
    }
    if (url.endsWith('/exa.language_server_pb.LanguageServerService/GetAllCascadeTrajectories')) {
      return {
        ok: true,
        async json() {
          return {
            trajectorySummaries: {
              'conv-main': { stepCount: 12 },
              'sub-1': { stepCount: 3, trajectoryMetadata: { subagentSpec: { role: 'Codebase Researcher' } } },
            },
          };
        },
      };
    }
    if (url.endsWith('/product.v1.ConversationService/ListConversations')) {
      return {
        ok: true,
        async json() {
          return {
            conversations: [
              { id: 'conv-main', state: { runState: 'RUN_STATE_RUNNING' }, annotations: { title: 'Main Task' } },
            ],
          };
        },
      };
    }
    return { ok: false, status: 404, async json() { return {}; } };
  };

  const tree = await fetchSubagentTree({
    env: { ANTIGRAVITY_LS_ADDRESS: '127.0.0.1:59999', ANTIGRAVITY_CSRF_TOKEN: 'tok' },
    fetchFn: fakeFetch,
  });
  assert.equal(tree.available, true);
  assert.equal(tree.running.length, 1);
  assert.equal(tree.running[0].subagentCount, 1);
  assert.equal(tree.running[0].activeSubagentCount, 1);
  assert.equal(tree.running[0].subagents[0].title, 'Codebase Researcher');
  assert.equal(calls.length, 3);
  assert.equal(calls[0].headers['Connect-Protocol-Version'], '1');
  assert.equal(calls[0].headers['x-antigravity-csrf-token'], 'tok');
});
