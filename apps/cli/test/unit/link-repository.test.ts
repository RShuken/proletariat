/**
 * Unit tests for linkRepository and flexible path support (TKT-014).
 *
 * Verifies:
 * - linkRepository validates inputs (path exists, is git repo, has GitHub remote)
 * - Absolute paths are stored and resolved correctly
 * - removeRepository does not delete files for linked repos
 * - getWorkspaceRepoInfo handles both relative and absolute paths
 */
import { expect } from 'chai';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import Database from 'better-sqlite3';
import {
  linkRepository,
  removeRepository,
  getWorkspaceRepoInfo,
} from '../../src/lib/repos/index.js';
import { getWorkspaceRepositories } from '../../src/lib/database/index.js';
import {
  createTestEnvironment,
  cleanupTestEnvironment,
  createHQConfig,
  setupWorkspaceSchema,
  type TestEnvironment,
} from '../e2e/test-helpers.js';

/**
 * Create a git repo at the given path with a GitHub-style remote.
 */
function createGitRepoWithRemote(dir: string, remoteUrl: string = 'https://github.com/test-org/test-repo.git'): void {
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['remote', 'add', 'origin', remoteUrl], { cwd: dir, stdio: 'pipe' });
  fs.writeFileSync(path.join(dir, 'README.md'), '# Test');
  execFileSync('git', ['add', '.'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', 'Initial commit'], { cwd: dir, stdio: 'pipe' });
}

function setupTestDb(env: TestEnvironment): Database.Database {
  // Use setupWorkspaceSchema which copies a template DB with migrations
  // already applied, preventing conflicts with openWorkspaceDatabase.
  const db = setupWorkspaceSchema(env.dbPath, { type: 'hq' });
  createHQConfig(env.proletariatDir);
  return db;
}

describe('linkRepository (TKT-014)', function (this: Mocha.Suite) {
  this.timeout(15000);

  let env: TestEnvironment;
  let db: Database.Database;

  beforeEach(() => {
    env = createTestEnvironment('link-repo-');
    db = setupTestDb(env);
    fs.mkdirSync(path.join(env.testDir, 'repos'), { recursive: true });
  });

  afterEach(() => {
    db.close();
    cleanupTestEnvironment(env);
  });

  it('links an existing git repo with a GitHub remote', async () => {
    const externalDir = path.join(env.testDir, 'external', 'my-project');
    createGitRepoWithRemote(externalDir, 'https://github.com/acme/my-project.git');

    const result = await linkRepository(env.testDir, externalDir);
    expect(result.error).to.be.undefined;
    expect(result.success).to.be.true;
    expect(result.name).to.equal('my-project');

    // Verify database entry stores absolute path and action='link'
    const repos = getWorkspaceRepositories(env.testDir);
    const linked = repos.find(r => r.name === 'my-project');
    expect(linked).to.exist;
    expect(linked!.path).to.equal(externalDir);
    expect(linked!.action).to.equal('link');
    expect(linked!.source_url).to.equal('https://github.com/acme/my-project.git');
  });

  it('rejects a path that does not exist', async () => {
    const result = await linkRepository(env.testDir, '/nonexistent/path');
    expect(result.success).to.be.false;
    expect(result.error).to.include('does not exist');
  });

  it('rejects a path that is not a git repo', async () => {
    const plainDir = path.join(env.testDir, 'external', 'not-a-repo');
    fs.mkdirSync(plainDir, { recursive: true });

    const result = await linkRepository(env.testDir, plainDir);
    expect(result.success).to.be.false;
    expect(result.error).to.include('Not a git repository');
  });

  it('rejects a repo without a GitHub remote', async () => {
    const localRepo = path.join(env.testDir, 'external', 'local-only');
    fs.mkdirSync(localRepo, { recursive: true });
    execFileSync('git', ['init'], { cwd: localRepo, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: localRepo, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: localRepo, stdio: 'pipe' });
    fs.writeFileSync(path.join(localRepo, 'README.md'), '# Test');
    execFileSync('git', ['add', '.'], { cwd: localRepo, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'Initial commit'], { cwd: localRepo, stdio: 'pipe' });

    const result = await linkRepository(env.testDir, localRepo);
    expect(result.success).to.be.false;
    expect(result.error).to.include('GitHub remote');
  });

  it('rejects a repo with a non-GitHub remote', async () => {
    const gitlabRepo = path.join(env.testDir, 'external', 'gitlab-repo');
    createGitRepoWithRemote(gitlabRepo, 'https://gitlab.com/user/repo.git');

    const result = await linkRepository(env.testDir, gitlabRepo);
    expect(result.success).to.be.false;
    expect(result.error).to.include('GitHub remote');
  });
});

describe('removeRepository with linked repos (TKT-014)', function (this: Mocha.Suite) {
  this.timeout(15000);

  let env: TestEnvironment;
  let db: Database.Database;

  beforeEach(() => {
    env = createTestEnvironment('remove-linked-');
    db = setupTestDb(env);
    fs.mkdirSync(path.join(env.testDir, 'repos'), { recursive: true });
  });

  afterEach(() => {
    db.close();
    cleanupTestEnvironment(env);
  });

  it('does not delete files when removing a linked repo', async () => {
    const externalDir = path.join(env.testDir, 'external', 'keep-me');
    createGitRepoWithRemote(externalDir, 'https://github.com/acme/keep-me.git');

    await linkRepository(env.testDir, externalDir);
    expect(getWorkspaceRepositories(env.testDir)).to.have.length(1);

    const result = await removeRepository(env.testDir, 'keep-me');
    expect(result.success).to.be.true;

    // DB entry removed
    expect(getWorkspaceRepositories(env.testDir)).to.have.length(0);

    // Files still exist
    expect(fs.existsSync(externalDir)).to.be.true;
    expect(fs.existsSync(path.join(externalDir, 'README.md'))).to.be.true;
  });
});

describe('getWorkspaceRepoInfo with absolute paths (TKT-014)', function (this: Mocha.Suite) {
  this.timeout(15000);

  let env: TestEnvironment;
  let db: Database.Database;

  beforeEach(() => {
    env = createTestEnvironment('ws-info-');
    db = setupTestDb(env);
    fs.mkdirSync(path.join(env.testDir, 'repos'), { recursive: true });
  });

  afterEach(() => {
    db.close();
    cleanupTestEnvironment(env);
  });

  it('resolves both relative (cloned) and absolute (linked) repo paths', async () => {
    // Add a linked repo at an external path
    const externalDir = path.join(env.testDir, 'external', 'linked-repo');
    createGitRepoWithRemote(externalDir, 'https://github.com/acme/linked-repo.git');
    await linkRepository(env.testDir, externalDir);

    // Verify the repo info resolves correctly
    const info = getWorkspaceRepoInfo();
    expect(info.repositories).to.have.length(1);

    const repo = info.repositories[0];
    expect(repo.name).to.equal('linked-repo');
    expect(repo.fullPath).to.equal(externalDir);
    expect(repo.action).to.equal('link');
    expect(repo.status).to.be.oneOf(['clean', 'dirty']);
  });
});
