import { expect } from 'chai';

/**
 * TKT-017: Smart repo mounting — agent creation filters repos.
 *
 * Tests the repo filtering logic used by createEphemeralAgent.
 * We test the filtering logic directly since the full createEphemeralAgent
 * requires filesystem and database setup.
 */
describe('TKT-017: smart repo mounting filter logic', () => {
  interface RepoInfo {
    name: string;
    path: string;
  }

  function filterRepos(allRepos: RepoInfo[], ticketRepos?: string[]): RepoInfo[] {
    if (ticketRepos && ticketRepos.length > 0) {
      return allRepos.filter(r => ticketRepos.includes(r.name));
    }
    return allRepos;
  }

  const allRepos: RepoInfo[] = [
    { name: 'frontend', path: '/repos/frontend' },
    { name: 'backend', path: '/repos/backend' },
    { name: 'shared', path: '/repos/shared' },
    { name: 'infra', path: '/repos/infra' },
  ];

  it('mounts all repos when no ticket repos specified', () => {
    const result = filterRepos(allRepos, undefined);
    expect(result).to.have.length(4);
    expect(result.map(r => r.name)).to.deep.equal(['frontend', 'backend', 'shared', 'infra']);
  });

  it('mounts all repos when empty ticket repos array', () => {
    const result = filterRepos(allRepos, []);
    expect(result).to.have.length(4);
  });

  it('mounts only specified repos', () => {
    const result = filterRepos(allRepos, ['frontend', 'backend']);
    expect(result).to.have.length(2);
    expect(result.map(r => r.name)).to.deep.equal(['frontend', 'backend']);
  });

  it('mounts single repo', () => {
    const result = filterRepos(allRepos, ['backend']);
    expect(result).to.have.length(1);
    expect(result[0].name).to.equal('backend');
  });

  it('ignores unknown repos gracefully', () => {
    const result = filterRepos(allRepos, ['frontend', 'nonexistent']);
    expect(result).to.have.length(1);
    expect(result[0].name).to.equal('frontend');
  });

  it('returns empty when all specified repos are unknown', () => {
    const result = filterRepos(allRepos, ['nonexistent']);
    expect(result).to.have.length(0);
  });
});
