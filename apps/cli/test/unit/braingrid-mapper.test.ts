import { expect } from 'chai';
import { mapRequirementToTicket } from '../../src/lib/braingrid/mapper.js';
import { extractFirstJson } from '../../src/lib/braingrid/client.js';
import type { BrainGridRequirement } from '../../src/lib/braingrid/client.js';

function makeReq(overrides: Partial<BrainGridRequirement> = {}): BrainGridRequirement {
  return {
    id: '3f195325-2122-4b00-97c3-821b792e391a',
    short_id: 'REQ-12',
    name: 'E9 — Curriculum Continuum & Content Ingestion',
    status: 'PLANNED',
    url: 'https://app.braingrid.ai/projects/PROJ-11/requirements/REQ-12',
    task_progress: { total: 4, completed: 0, progress_percentage: 0 },
    ...overrides,
  };
}

describe('mapRequirementToTicket', () => {
  it('builds the title as "<short_id>: <name>"', () => {
    expect(mapRequirementToTicket(makeReq()).title)
      .to.equal('REQ-12: E9 — Curriculum Continuum & Content Ingestion');
  });

  it('embeds the BrainGrid short_id and URL in the body', () => {
    const { description } = mapRequirementToTicket(makeReq());
    expect(description).to.include('REQ-12');
    expect(description).to.include('https://app.braingrid.ai/projects/PROJ-11/requirements/REQ-12');
  });

  it('instructs the agent to pull tasks from BrainGrid (no spec duplication)', () => {
    const { description } = mapRequirementToTicket(makeReq());
    expect(description).to.include('braingrid task list --requirement REQ-12 --format markdown');
  });

  it('stays thin — never embeds the full requirement spec', () => {
    // even if a huge spec field were present, the mirror must ignore it
    const fat = makeReq({ name: 'X' }) as BrainGridRequirement & { description: string };
    fat.description = 'a'.repeat(8000);
    const out = mapRequirementToTicket(fat);
    // thin = no full spec duplication (instructions/DoD are fine); the real spec is thousands of chars
    expect((out.description ?? '').length).to.be.lessThan(1200);
  });

  it('tags the ticket with source/braingrid and bg/<key> labels', () => {
    const { labels } = mapRequirementToTicket(makeReq());
    expect(labels).to.include('source/braingrid');
    expect(labels).to.include('bg/REQ-12');
  });

  it('records idempotency metadata keyed on the short_id', () => {
    const { metadata } = mapRequirementToTicket(makeReq());
    expect(metadata?.external_source).to.equal('braingrid');
    expect(metadata?.external_key).to.equal('REQ-12');
  });

  it('omits the task count line when task_progress is absent', () => {
    const { description } = mapRequirementToTicket(makeReq({ task_progress: undefined }));
    expect(description).to.not.include('**Tasks:**');
  });

  it('is deterministic for identical input', () => {
    const a = mapRequirementToTicket(makeReq());
    const b = mapRequirementToTicket(makeReq());
    expect(a).to.deep.equal(b);
  });
});

describe('extractFirstJson', () => {
  it('parses a clean array', () => {
    expect(extractFirstJson<number[]>('[1,2,3]')).to.deep.equal([1, 2, 3]);
  });

  it('parses a clean object', () => {
    expect(extractFirstJson<{ a: number }>('{"a":1}')).to.deep.equal({ a: 1 });
  });

  it('strips leading spinner noise', () => {
    expect(extractFirstJson('⠋⠙ Loading... [{"id":"REQ-1"}]'))
      .to.deep.equal([{ id: 'REQ-1' }]);
  });

  it('strips the trailing "update available" notice', () => {
    expect(extractFirstJson('["REQ-1"]\n\n⚠️  Update available: 0.2.67 → 0.2.68\n'))
      .to.deep.equal(['REQ-1']);
  });

  it('is not confused by brackets inside strings', () => {
    expect(extractFirstJson<{ name: string }>('{"name":"a [b] {c}"}'))
      .to.deep.equal({ name: 'a [b] {c}' });
  });

  it('throws when no JSON is present', () => {
    expect(() => extractFirstJson('just spinner noise')).to.throw(/no JSON found/);
  });
});
