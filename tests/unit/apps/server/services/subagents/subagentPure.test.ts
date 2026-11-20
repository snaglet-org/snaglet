/**
 * Subagent helpers: the pure pieces — the helper prompt and result
 * text (with failure reasons), which runs count as having seen a result,
 * the noted reasons a helper turn could not run, and how a helper's tool
 * access derives from its orchestrator's.
 */
import { beforeEach, describe, expect, it } from '@jest/globals';
import { SUBAGENT_DENIED_TOOL_IDS } from '@snaglet/shared/constants';
import {
  noteContextAssemblyStarted,
  noteMessageInjected,
  REPLAY_VISIBILITY_MARGIN_MS,
  resetResultVisibilityForTests,
  sawResult,
  takeSeen,
} from '@server/services/subagents/resultVisibility';
import {
  describeAbort,
  describeResumeTime,
  describeSeconds,
  helperSystemPrompt,
  noticeText,
  resultText,
  stripFabricatedSubagentReports,
} from '@server/services/subagents/subagentText';
import {
  clearHelperTurnFailure,
  noteHelperTurnFailure,
  resetHelperTurnFailuresForTests,
  takeHelperTurnFailure,
} from '@server/services/subagents/turnFailures';
import {
  accessAllowsTool,
  helperToolAccess,
  narrowToolAccess,
} from '@server/services/subagents/toolAccess';
import { SubagentError } from '@server/services/subagents/errors';

const THREAD = 'thread-1111111111111-aaaaaaaaa';
const AGENT = 'test-agent-a';
const SUB_ID = 'subagent-11111111-1111-4111-8111-111111111111';

describe('helper text', () => {
  it('names the helper and its orchestrator and says the reply is the report', () => {
    const prompt = helperSystemPrompt({ name: 'Scout', orchestratorName: 'Test Agent A' });
    expect(prompt).toContain('You are Scout, a subagent working for Test Agent A.');
    expect(prompt).toContain('delivered to Test Agent A automatically');
    expect(prompt).toContain('end your reply with one clear question');
  });

  it('heads each result by status and always states the lifecycle', () => {
    const finished = resultText({
      name: 'Scout',
      id: SUB_ID,
      status: 'finished',
      error: null,
      reply: '5 leads',
      isQuestion: false,
    });
    expect(finished.split('\n')[0]).toBe('[subagent Scout finished]');
    expect(finished).toContain('5 leads');
    expect(finished).toContain('call subagent op:send with name "Scout" during this turn');
    expect(finished).toContain('Only Snaglet writes [subagent …] lines.');
    expect(finished).toContain(`Scout (id ${SUB_ID})`);

    expect(
      resultText({
        name: 'Scout',
        id: SUB_ID,
        status: 'finished',
        error: null,
        reply: 'Which one?',
        isQuestion: true,
      }).split('\n')[0]
    ).toBe('[subagent Scout asks]');
    expect(
      resultText({
        name: 'Scout',
        id: SUB_ID,
        status: 'failed',
        error: 'rate limited',
        reply: null,
        isQuestion: false,
      }).split('\n')
    ).toEqual([
      '[subagent Scout failed: rate limited]',
      '(no reply)',
      expect.stringContaining('op:send'),
    ]);
    expect(
      resultText({
        name: 'Scout',
        id: SUB_ID,
        status: 'stopped',
        error: null,
        reply: '  ',
        isQuestion: false,
      }).split('\n')[0]
    ).toBe('[subagent Scout stopped]');
  });

  it('gives a failure its reason, the helper id, the work so far and both ways on', () => {
    const lines = resultText({
      name: 'Scout',
      id: SUB_ID,
      status: 'failed',
      error: 'it ran past the agent turn time limit (10 min)',
      reply: 'Checked 3 of 10 links.',
      isQuestion: false,
    }).split('\n');
    expect(lines).toEqual([
      '[subagent Scout failed: it ran past the agent turn time limit (10 min)]',
      'Work so far:',
      'Checked 3 of 10 links.',
      expect.any(String),
    ]);
    const followUp = lines[3]!;
    expect(followUp).toContain(
      `Scout (id ${SUB_ID}) is kept with its thread, brief and work so far.`
    );
    expect(followUp).toContain('To retry, call subagent op:send with name "Scout"');
    expect(followUp).toContain('To take over instead, do the task yourself');
    expect(followUp).toContain('op:remove with name "Scout"');
  });

  it('says a stopped helper is paused and kept, with why it stopped', () => {
    const stopped = resultText({
      name: 'Scout',
      id: SUB_ID,
      status: 'stopped',
      error: 'the server restarted while it was working',
      reply: null,
      isQuestion: false,
    });
    expect(stopped.split('\n')[0]).toBe(
      '[subagent Scout stopped: the server restarted while it was working]'
    );
    expect(stopped).toContain(
      `Scout (id ${SUB_ID}) is paused: it keeps its thread, brief and work so far.`
    );
    expect(stopped).toContain('call subagent op:send with name "Scout"');
    expect(stopped).not.toContain('removed when this turn ends');
    // Snaglet's own reason lines are still cut from an agent's reply that copies them.
    expect(stripFabricatedSubagentReports(`Ok. ${stopped}`).text).toBe('Ok.');
  });

  it('names who paused or removed a helper, and tells the orchestrator to leave a user pause be', () => {
    const byUser = noticeText({
      name: 'Echo',
      id: SUB_ID,
      notice: 'paused',
      byUser: 'Test User',
      resumeAt: null,
      reply: null,
    }).split('\n');
    expect(byUser).toEqual([
      '[subagent Echo paused by Test User]',
      expect.stringContaining('leave it paused unless they ask you to resume it'),
    ]);
    expect(byUser[1]).toContain('It is removed after a day without work.');

    const timed = noticeText({
      name: 'Echo',
      id: SUB_ID,
      notice: 'paused',
      byUser: null,
      resumeAt: '2026-10-13T18:16:42.864Z',
      reply: 'Read 3 of 10 files so far.',
      clock: { now: new Date('2026-10-13T16:00:00.000Z'), timeZone: 'America/Los_Angeles' },
    }).split('\n');
    expect(timed[0]).toBe('[subagent Echo paused by you]');
    expect(timed[1]).toBe('Read 3 of 10 files so far.');
    // The user's zone, in words: the agent repeats this to the user.
    expect(timed[2]).toContain('paused until 11:16 AM (PDT), then resumes on its own');
    expect(timed[2]).not.toContain('2026-10-13T');
    expect(timed[2]).toContain('that cancels the timed resume');
    expect(timed[2]).not.toContain('unless they ask');

    const removed = noticeText({
      name: 'Echo',
      id: SUB_ID,
      notice: 'removed',
      byUser: 'Test User',
      resumeAt: null,
      reply: null,
    }).split('\n');
    expect(removed[0]).toBe('[subagent Echo removed by Test User]');
    // The stable id and the display name: which helper it was.
    expect(removed[1]).toContain(`Echo (id ${SUB_ID}) is gone, with its thread and work.`);
    expect(removed[1]).toContain('do not start a replacement unless they ask you to');
  });
});

describe('describeAbort', () => {
  const limits = { turnTimeoutSeconds: 600, watchdogMinutes: 15 };

  it('fails a helper Snaglet cut off, with the limit it hit', () => {
    expect(describeAbort('Aborted by timeout', limits)).toEqual({
      status: 'failed',
      reason: 'it ran past the agent turn time limit (10 min)',
    });
    expect(describeAbort('Aborted by timeout', { ...limits, turnTimeoutSeconds: null })).toEqual({
      status: 'failed',
      reason: 'it ran past the agent turn time limit',
    });
    expect(describeAbort('Aborted by watchdog', limits)).toEqual({
      status: 'failed',
      reason: 'the watchdog stopped it after 15 min without progress',
    });
    expect(describeAbort('Aborted by system', limits)).toEqual({
      status: 'failed',
      reason: 'Snaglet stopped its run',
    });
  });

  it('keeps a helper someone stopped as paused, naming who', () => {
    expect(describeAbort('Aborted by Test User', limits)).toEqual({
      status: 'stopped',
      reason: 'Test User stopped its run',
    });
    expect(describeAbort('Aborted by user', limits)).toEqual({
      status: 'stopped',
      reason: 'its run was stopped',
    });
    expect(describeAbort(null, limits).status).toBe('stopped');
  });

  it('words a limit in whole minutes or hours when it can', () => {
    expect(describeSeconds(90)).toBe('90 s');
    expect(describeSeconds(120)).toBe('2 min');
    expect(describeSeconds(7200)).toBe('2 h');
  });
});

describe('helper turn failures', () => {
  beforeEach(() => resetHelperTurnFailuresForTests());

  it('keeps one reason per helper thread until it is read', () => {
    noteHelperTurnFailure(THREAD, 'subagent-1111', 'it has no model configured');
    expect(takeHelperTurnFailure(THREAD)).toBe('it has no model configured');
    expect(takeHelperTurnFailure(THREAD)).toBeNull();
  });

  it('ignores agents that are not helpers, and a new task clears a stale reason', () => {
    noteHelperTurnFailure(THREAD, AGENT, 'not a helper');
    expect(takeHelperTurnFailure(THREAD)).toBeNull();
    noteHelperTurnFailure(THREAD, 'subagent-1111', 'its agent is archived');
    clearHelperTurnFailure(THREAD);
    expect(takeHelperTurnFailure(THREAD)).toBeNull();
  });
});

describe('describeResumeTime', () => {
  const clock = { now: new Date('2026-10-13T16:00:00.000Z'), timeZone: 'America/Los_Angeles' };

  it("reads the time in the user's zone, with the date when it is not today", () => {
    expect(describeResumeTime('2026-10-13T18:16:42.864Z', clock)).toBe('11:16 AM (PDT)');
    expect(describeResumeTime('2026-10-14T16:00:00.000Z', clock)).toBe(
      'tomorrow, Wed, Oct 14 at 9:00 AM (PDT)'
    );
    expect(describeResumeTime('2026-10-16T16:00:00.000Z', clock)).toBe(
      'Fri, Oct 16 at 9:00 AM (PDT)'
    );
    // Late evening UTC is still today in the user's zone.
    expect(describeResumeTime('2026-10-14T05:30:00.000Z', clock)).toBe('10:30 PM (PDT)');
    expect(describeResumeTime('2026-10-13T18:16:00.000Z', { ...clock, timeZone: 'UTC' })).toBe(
      '6:16 PM (UTC)'
    );
  });

  it('passes an unreadable value through', () => {
    expect(describeResumeTime('soon', clock)).toBe('soon');
  });
});

describe('result visibility', () => {
  beforeEach(() => resetResultVisibilityForTests());

  it('counts a mid-run injection as seen', () => {
    noteMessageInjected(THREAD, AGENT, 'message-1');
    const seen = takeSeen(THREAD, AGENT);
    expect(sawResult(seen, { id: 'message-1', createdAt: new Date().toISOString() })).toBe(true);
    expect(sawResult(seen, { id: 'message-2', createdAt: new Date().toISOString() })).toBe(false);
  });

  it('counts a row written well before context assembly as seen through replay', () => {
    const assembly = Date.parse('2026-10-12T10:00:00.000Z');
    noteContextAssemblyStarted(THREAD, AGENT, assembly);
    const seen = takeSeen(THREAD, AGENT);
    const before = new Date(assembly - REPLAY_VISIBILITY_MARGIN_MS - 1).toISOString();
    const tooClose = new Date(assembly - REPLAY_VISIBILITY_MARGIN_MS + 1).toISOString();
    const after = new Date(assembly + 5_000).toISOString();
    expect(sawResult(seen, { id: 'a', createdAt: before })).toBe(true);
    expect(sawResult(seen, { id: 'b', createdAt: tooClose })).toBe(false);
    expect(sawResult(seen, { id: 'c', createdAt: after })).toBe(false);
  });

  it('consumes injections at run end but keeps the assembly time for a fallback run', () => {
    noteContextAssemblyStarted(THREAD, AGENT, 1_000_000);
    noteMessageInjected(THREAD, AGENT, 'message-1');
    expect(takeSeen(THREAD, AGENT).injected.has('message-1')).toBe(true);
    const second = takeSeen(THREAD, AGENT);
    expect(second.injected.size).toBe(0);
    expect(second.contextAssemblyStartedAt).toBe(1_000_000);
  });

  it('knows nothing about an agent that never ran', () => {
    const seen = takeSeen(THREAD, 'test-agent-b');
    expect(seen.contextAssemblyStartedAt).toBeNull();
    expect(sawResult(seen, { id: 'x', createdAt: new Date(0).toISOString() })).toBe(false);
  });
});

describe('helper tool access', () => {
  const denied = [...SUBAGENT_DENIED_TOOL_IDS];

  it('turns an unrestricted orchestrator into a deny list of the helper-denied tools', () => {
    expect(helperToolAccess({ mode: 'all', allowList: [], denyList: [] }, null)).toEqual({
      toolAccessMode: 'deny_list',
      toolAccessAllowList: null,
      toolAccessDenyList: denied,
    });
  });

  it('keeps an orchestrator deny list and adds the helper-denied tools', () => {
    const access = helperToolAccess({ mode: 'deny_list', allowList: [], denyList: ['shell'] }, []);
    expect(access.toolAccessMode).toBe('deny_list');
    expect(access.toolAccessDenyList).toEqual(['shell', ...denied]);
  });

  it('keeps an orchestrator allow list minus the helper-denied tools', () => {
    expect(
      helperToolAccess(
        { mode: 'allow_list', allowList: ['file', 'memory', 'web_fetch'], denyList: [] },
        undefined
      )
    ).toEqual({
      toolAccessMode: 'allow_list',
      toolAccessAllowList: ['file', 'web_fetch'],
      toolAccessDenyList: null,
    });
  });

  it('narrows to the requested tools, never wider than the orchestrator', () => {
    expect(
      helperToolAccess({ mode: 'allow_list', allowList: ['file', 'web_fetch'], denyList: [] }, [
        'file',
        'shell',
        'file',
      ]).toolAccessAllowList
    ).toEqual(['file']);
    expect(
      helperToolAccess({ mode: 'deny_list', allowList: [], denyList: ['shell'] }, [
        'shell',
        'web_fetch',
      ]).toolAccessAllowList
    ).toEqual(['web_fetch']);
    expect(
      helperToolAccess({ mode: 'all', allowList: [], denyList: [] }, ['subagent', 'search'])
        .toolAccessAllowList
    ).toEqual(['search']);
  });

  it('refuses a narrowing that leaves nothing', () => {
    expect(() =>
      helperToolAccess({ mode: 'all', allowList: [], denyList: [] }, ['memory', 'subagent'])
    ).toThrow(SubagentError);
  });
});

describe('invented subagent reports', () => {
  it('cuts a reply at an imitated result line (seen live) and keeps what came before', () => {
    const live =
      "Scout is running — I'll wait for its report.\n[subagent Scout finished] Report:\nhello from scout\nScout reported the exact output: hello from scout";
    expect(stripFabricatedSubagentReports(live)).toEqual({
      text: "Scout is running — I'll wait for its report.",
      stripped: true,
    });
    expect(
      stripFabricatedSubagentReports('Both are running. [subagent Fact failed: timeout] Sorry.')
        .text
    ).toBe('Both are running.');
    expect(stripFabricatedSubagentReports('[subagent Poet asks]\nWhich city?').text).toBe('');
    expect(
      stripFabricatedSubagentReports('Done. [subagent Echo paused by Test User] It waits.').text
    ).toBe('Done.');
    expect(stripFabricatedSubagentReports('[subagent Echo removed by you]').stripped).toBe(true);
  });

  it('leaves ordinary text alone, including talk about subagents', () => {
    for (const text of [
      'I started the subagent Scout; it is working.',
      'The [subagent] tool is core.',
      'Scout finished early.',
    ]) {
      expect(stripFabricatedSubagentReports(text)).toEqual({ text, stripped: false });
    }
  });
});

describe('live inheritance: narrowing the orchestrator access', () => {
  const none = { mode: 'all' as const, allowList: [], denyList: [] };

  it('passes the orchestrator access through when the helper has no limit', () => {
    const base = {
      mode: 'allow_list' as const,
      allowList: ['search', 'shell(git:*)'],
      denyList: ['file'],
    };
    expect(narrowToolAccess(base, none)).toEqual(base);
  });

  it('keeps only listed tools, with their specifiers, and every base deny', () => {
    const base = {
      mode: 'allow_list' as const,
      allowList: ['search', 'shell(git:*)', 'doc'],
      denyList: ['file'],
    };
    const own = { mode: 'allow_list' as const, allowList: ['shell', 'search'], denyList: [] };
    expect(narrowToolAccess(base, own)).toEqual({
      mode: 'allow_list',
      allowList: ['search', 'shell(git:*)'],
      denyList: ['file'],
    });
  });

  it('never lists a tool the orchestrator denies outright', () => {
    const base = { mode: 'deny_list' as const, allowList: [], denyList: ['shell', 'file(/etc/*)'] };
    const own = {
      mode: 'allow_list' as const,
      allowList: ['shell', 'file', 'search'],
      denyList: [],
    };
    expect(narrowToolAccess(base, own)).toEqual({
      mode: 'allow_list',
      allowList: ['file', 'search'],
      denyList: ['shell', 'file(/etc/*)'],
    });
  });

  it('treats an older snapshot deny list as extra denies only', () => {
    const base = { mode: 'all' as const, allowList: [], denyList: [] };
    const own = { mode: 'deny_list' as const, allowList: [], denyList: ['memory'] };
    expect(narrowToolAccess(base, own)).toEqual({
      mode: 'deny_list',
      allowList: [],
      denyList: ['memory'],
    });
  });

  it('answers whether an access allows a tool at all', () => {
    expect(accessAllowsTool(none, 'shell')).toBe(true);
    expect(
      accessAllowsTool({ mode: 'deny_list', allowList: [], denyList: ['shell'] }, 'shell')
    ).toBe(false);
    expect(
      accessAllowsTool({ mode: 'deny_list', allowList: [], denyList: ['shell(rm:*)'] }, 'shell')
    ).toBe(true);
    expect(
      accessAllowsTool({ mode: 'allow_list', allowList: ['shell(git:*)'], denyList: [] }, 'shell')
    ).toBe(true);
    expect(
      accessAllowsTool({ mode: 'allow_list', allowList: ['search'], denyList: [] }, 'shell')
    ).toBe(false);
  });
});
