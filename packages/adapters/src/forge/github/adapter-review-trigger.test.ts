/**
 * Tests for the review-request trigger feature in GitHubAdapter.
 *
 * Separate file from adapter.test.ts because this needs to mock.module('@archon/core')
 * to intercept handleMessage, which would conflict with adapter.test.ts's direct import.
 */
import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';

// Mock logger
const mockLogger = {
  fatal: mock(() => undefined),
  error: mock(() => undefined),
  warn: mock(() => undefined),
  info: mock(() => undefined),
  debug: mock(() => undefined),
  trace: mock(() => undefined),
  child: mock(function (this: unknown) {
    return this;
  }),
  bindings: mock(() => ({ module: 'test' })),
  isLevelEnabled: mock(() => true),
  level: 'info',
};
mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
  getArchonWorkspacesPath: () => '/tmp/archon-test/workspaces',
  getCommandFolderSearchPaths: () => ['.archon/commands'],
}));

mock.module('child_process', () => ({
  execFile: mock(
    (
      _cmd: string,
      _args: string[],
      _opts: unknown,
      callback: (err: Error | null, result: { stdout: string; stderr: string }) => void
    ) => {
      callback(null, { stdout: '', stderr: '' });
    }
  ),
}));

// Mock database modules
const mockGetOrCreateConversation = mock(async () => ({
  id: 'conv-test',
  codebase_id: null,
  cwd: null,
  isolation_env_id: null,
}));
const mockUpdateConversation = mock(async () => {});

mock.module('@archon/core/db/conversations', () => ({
  getOrCreateConversation: mockGetOrCreateConversation,
  updateConversation: mockUpdateConversation,
}));

const mockFindCodebaseByRepoUrl = mock(async () => null);
const mockCreateCodebase = mock(async () => ({
  id: 'codebase-test',
  name: 'testuser/testrepo',
  default_cwd: '/tmp/test',
}));

mock.module('@archon/core/db/codebases', () => ({
  findCodebaseByRepoUrl: mockFindCodebaseByRepoUrl,
  createCodebase: mockCreateCodebase,
  updateCodebase: mock(async () => {}),
  getCodebaseCommands: mock(async () => ({})),
  updateCodebaseCommands: mock(async () => {}),
}));

// Mock @archon/git
mock.module('@archon/git', () => ({
  cloneRepository: mock(async () => ({ ok: true, value: undefined })),
  syncRepository: mock(async () => ({ ok: true, value: undefined })),
  addSafeDirectory: mock(async () => undefined),
  isWorktreePath: mock(async () => false),
  toRepoPath: (p: string) => p,
  toBranchName: (n: string) => n,
  toWorktreePath: (p: string) => p,
}));

// Mock @archon/core — intercept handleMessage
const mockHandleMessage = mock(async () => {});

class MockConversationLockManager {
  acquireLock = mock(async (_id: string, handler: () => Promise<void>) => {
    await handler();
  });
  getStats() {
    return {
      active: 0,
      queuedTotal: 0,
      queuedByConversation: [],
      maxConcurrent: 10,
      activeConversationIds: [],
    };
  }
}

mock.module('@archon/core', () => ({
  handleMessage: mockHandleMessage,
  classifyAndFormatError: (err: Error) => err.message,
  toError: (e: unknown) => (e instanceof Error ? e : new Error(String(e))),
  getLinkedIssueNumbers: mock(async () => []),
  onConversationClosed: mock(async () => {}),
  ConversationNotFoundError: class extends Error {},
  ConversationLockManager: MockConversationLockManager,
}));

import { GitHubAdapter } from './adapter';

/**
 * Creates a review_requested webhook payload.
 */
function createReviewRequestPayload(
  requestedReviewer: string,
  sender: string,
  prNumber = 42,
  prTitle = 'Add feature X'
): string {
  return JSON.stringify({
    action: 'review_requested',
    pull_request: {
      number: prNumber,
      title: prTitle,
      body: 'PR description',
      user: { login: sender },
      state: 'open',
    },
    requested_reviewer: { login: requestedReviewer },
    repository: {
      owner: { login: 'testowner' },
      name: 'testrepo',
      full_name: 'testowner/testrepo',
      html_url: 'https://github.com/testowner/testrepo',
      default_branch: 'main',
    },
    sender: { login: sender },
  });
}

describe('GitHubAdapter review trigger', () => {
  let originalTriggerUser: string | undefined;
  let originalTriggerWorkflow: string | undefined;
  let originalAllowedUsers: string | undefined;

  beforeEach(() => {
    originalTriggerUser = process.env.GITHUB_REVIEW_TRIGGER_USER;
    originalTriggerWorkflow = process.env.GITHUB_REVIEW_TRIGGER_WORKFLOW;
    originalAllowedUsers = process.env.GITHUB_ALLOWED_USERS;
    delete process.env.GITHUB_ALLOWED_USERS;
    mockHandleMessage.mockClear();
    mockGetOrCreateConversation.mockClear();
    mockFindCodebaseByRepoUrl.mockClear();
    mockCreateCodebase.mockClear();
    mockUpdateConversation.mockClear();
    mockLogger.info.mockClear();
    mockLogger.debug.mockClear();
    mockLogger.error.mockClear();
    mockLogger.warn.mockClear();
  });

  afterEach(() => {
    if (originalTriggerUser !== undefined) {
      process.env.GITHUB_REVIEW_TRIGGER_USER = originalTriggerUser;
    } else {
      delete process.env.GITHUB_REVIEW_TRIGGER_USER;
    }
    if (originalTriggerWorkflow !== undefined) {
      process.env.GITHUB_REVIEW_TRIGGER_WORKFLOW = originalTriggerWorkflow;
    } else {
      delete process.env.GITHUB_REVIEW_TRIGGER_WORKFLOW;
    }
    if (originalAllowedUsers !== undefined) {
      process.env.GITHUB_ALLOWED_USERS = originalAllowedUsers;
    } else {
      delete process.env.GITHUB_ALLOWED_USERS;
    }
  });

  function createTriggerAdapter(triggerUser?: string, triggerWorkflow?: string): GitHubAdapter {
    if (triggerUser) {
      process.env.GITHUB_REVIEW_TRIGGER_USER = triggerUser;
    } else {
      delete process.env.GITHUB_REVIEW_TRIGGER_USER;
    }
    if (triggerWorkflow) {
      process.env.GITHUB_REVIEW_TRIGGER_WORKFLOW = triggerWorkflow;
    } else {
      delete process.env.GITHUB_REVIEW_TRIGGER_WORKFLOW;
    }

    const lockManager = new MockConversationLockManager();
    const adapter = new GitHubAdapter(
      'fake-token',
      'fake-secret',
      lockManager as unknown as InstanceType<typeof MockConversationLockManager>,
      'Archon'
    );
    // Mock signature verification
    // @ts-expect-error - accessing private method for testing
    adapter.verifySignature = mock(() => true);
    // Mock octokit for repos.get and pulls.get
    // @ts-expect-error - accessing private property for testing
    adapter.octokit = {
      rest: {
        repos: {
          get: mock(async () => ({
            data: { default_branch: 'main' },
          })),
        },
        pulls: {
          get: mock(async () => ({
            data: {
              head: {
                ref: 'feature-x',
                sha: 'abc123def456',
                repo: { full_name: 'testowner/testrepo' },
              },
              base: {
                repo: { full_name: 'testowner/testrepo' },
              },
            },
          })),
        },
        issues: {
          createComment: mock(async () => ({ data: {} })),
        },
      },
    };
    return adapter;
  }

  test('triggers workflow when review requested from configured user', async () => {
    const adapter = createTriggerAdapter('reviewbot');
    const payload = createReviewRequestPayload('ReviewBot', 'developer');

    await adapter.handleWebhook(payload, 'mock-signature');

    expect(mockHandleMessage).toHaveBeenCalledTimes(1);
    const [, , message, options] = mockHandleMessage.mock.calls[0];
    expect(message).toBe('/workflow run archon-smart-pr-review');
    expect(options.issueContext).toContain('Pull Request #42');
    expect(options.issueContext).toContain('Add feature X');
    expect(options.isolationHints).toBeDefined();
    expect(options.isolationHints.workflowType).toBe('pr');
  });

  test('ignores review request from non-matching user', async () => {
    const adapter = createTriggerAdapter('reviewbot');
    const payload = createReviewRequestPayload('someone-else', 'developer');

    await adapter.handleWebhook(payload, 'mock-signature');

    // Falls through to parseEvent which returns null for review_requested
    expect(mockHandleMessage).not.toHaveBeenCalled();
  });

  test('disabled when env var is unset', async () => {
    const adapter = createTriggerAdapter(); // No trigger user
    const payload = createReviewRequestPayload('anyone', 'developer');

    await adapter.handleWebhook(payload, 'mock-signature');

    expect(mockHandleMessage).not.toHaveBeenCalled();
  });

  test('uses custom workflow name from env var', async () => {
    const adapter = createTriggerAdapter('reviewbot', 'my-custom-review');
    const payload = createReviewRequestPayload('ReviewBot', 'developer');

    await adapter.handleWebhook(payload, 'mock-signature');

    expect(mockHandleMessage).toHaveBeenCalledTimes(1);
    const [, , message] = mockHandleMessage.mock.calls[0];
    expect(message).toBe('/workflow run my-custom-review');
  });

  test('matches reviewer case-insensitively', async () => {
    const adapter = createTriggerAdapter('ReviewBot');
    const payload = createReviewRequestPayload('REVIEWBOT', 'developer');

    await adapter.handleWebhook(payload, 'mock-signature');

    expect(mockHandleMessage).toHaveBeenCalledTimes(1);
  });

  test('respects authorization whitelist for review events', async () => {
    process.env.GITHUB_ALLOWED_USERS = 'allowed-user';
    const adapter = createTriggerAdapter('reviewbot');
    const payload = createReviewRequestPayload('ReviewBot', 'unauthorized-user');

    await adapter.handleWebhook(payload, 'mock-signature');

    // Auth check happens before review trigger check — unauthorized sender rejected
    expect(mockHandleMessage).not.toHaveBeenCalled();
  });

  test('handles empty string trigger user as disabled', async () => {
    const adapter = createTriggerAdapter('  '); // Whitespace-only
    const payload = createReviewRequestPayload('anyone', 'developer');

    await adapter.handleWebhook(payload, 'mock-signature');

    expect(mockHandleMessage).not.toHaveBeenCalled();
  });

  test('isolation hints include PR branch info', async () => {
    const adapter = createTriggerAdapter('reviewbot');
    const payload = createReviewRequestPayload('ReviewBot', 'developer');

    await adapter.handleWebhook(payload, 'mock-signature');

    const [, , , options] = mockHandleMessage.mock.calls[0];
    expect(options.isolationHints.prBranch).toBe('feature-x');
    expect(options.isolationHints.prSha).toBe('abc123def456');
    expect(options.isolationHints.isForkPR).toBe(false);
  });
});
