import { beforeEach, describe, expect, it, vi } from 'vitest';

import { findGrantsByUserId } from '@/domains/user-roles/user-roles.repository';
import { getUserByEmail } from '@/domains/users/users.service';
import { auth } from '@/lib/auth';
import { PERMISSIONS } from '@/lib/permissions';
import { ok } from '@/lib/types';
import { server } from '@/server/server';

import * as bibleService from './bibles.service';
import './bibles.route';

vi.mock('@/lib/auth', () => ({
  auth: {
    api: { getSession: vi.fn() },
    handler: vi.fn(),
  },
}));

vi.mock('@/db', () => {
  const mockQueryBuilder = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue([{ activeOrgId: 1 }]),
  };
  return {
    db: { select: vi.fn(() => mockQueryBuilder), insert: vi.fn(), update: vi.fn() },
  };
});

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

vi.mock('@/domains/users/users.service', () => ({
  getUserByEmail: vi.fn(),
}));

vi.mock('@/domains/user-roles/user-roles.repository', () => ({
  findGrantsByUserId: vi.fn(),
}));

vi.mock('./bibles.service', () => ({
  getAllBibles: vi.fn(),
  getBibleById: vi.fn(),
  getBiblesByLanguageId: vi.fn(),
  searchSourceBibles: vi.fn(),
  createBible: vi.fn(),
  updateBible: vi.fn(),
  deleteBible: vi.fn(),
}));

const MOCK_USER = {
  id: 1,
  email: 'test@example.com',
  status: 'verified' as const,
};

function authenticate() {
  vi.mocked(auth.api.getSession as any).mockResolvedValue({
    session: { id: 's1', updatedAt: new Date(), expiresAt: new Date(Date.now() + 1e9) },
    user: { email: MOCK_USER.email },
  });
  vi.mocked(getUserByEmail as any).mockResolvedValue(ok(MOCK_USER));
  vi.mocked(findGrantsByUserId as any).mockResolvedValue(ok([]));
}

describe('get /bibles', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns all bibles when updatedAfter is omitted', async () => {
    authenticate();
    const bibles = [
      {
        id: 1,
        name: 'ESV',
        abbreviation: 'ESV',
        languageId: 1,
        hasAudio: false,
        provider: 'dbl',
      },
    ];
    vi.mocked(bibleService.getAllBibles).mockResolvedValue(ok(bibles as any));

    const res = await server.request('/bibles');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(bibles);
    expect(bibleService.getAllBibles).toHaveBeenCalledWith(undefined);
  });

  it('returns an empty array when nothing changed after updatedAfter', async () => {
    authenticate();
    vi.mocked(bibleService.getAllBibles).mockResolvedValue(ok([]));

    const res = await server.request('/bibles?updatedAfter=2025-01-15T12:00:00.000Z');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
    expect(bibleService.getAllBibles).toHaveBeenCalledWith(new Date('2025-01-15T12:00:00.000Z'));
  });

  it('returns 400 for a malformed updatedAfter timestamp', async () => {
    authenticate();

    const res = await server.request('/bibles?updatedAfter=@@@');

    expect(res.status).toBe(400);
    expect(bibleService.getAllBibles).not.toHaveBeenCalled();
  });

  it('returns 400 for an empty updatedAfter instead of returning the full catalogue', async () => {
    authenticate();

    const res = await server.request('/bibles?updatedAfter=');

    expect(res.status).toBe(400);
    expect(bibleService.getAllBibles).not.toHaveBeenCalled();
  });

  it('returns 400 for an updatedAfter date-time without a time zone', async () => {
    authenticate();

    const res = await server.request('/bibles?updatedAfter=2025-01-01T00:00:00');

    expect(res.status).toBe(400);
    expect(bibleService.getAllBibles).not.toHaveBeenCalled();
  });
});

describe('superAdmin provider-aware Bible writes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authenticate();
    vi.mocked(findGrantsByUserId).mockResolvedValue(
      ok([
        {
          orgId: null,
          projectId: null,
          permissions: new Set([PERMISSIONS.ROLE_ASSIGN_ORG_MANAGER]),
        },
      ])
    );
  });

  const base = { name: 'Test', abbreviation: 'TEST', languageId: 1 };
  const response = {
    id: 1,
    ...base,
    provider: 'dbl',
    ttsLicenseStatus: 'unknown' as const,
    hasAudio: false,
    textBibleKey: null,
    selectedRecordingKey: null,
    updatedAt: null,
  };

  it.each(['dbl', 'aquifer', 'youversion'] as const)(
    'POST and PATCH accept an explicit FK and preserve %s responses',
    async (provider) => {
      vi.mocked(bibleService.createBible).mockResolvedValue(ok({ ...response, provider }));
      vi.mocked(bibleService.updateBible).mockResolvedValue(ok({ ...response, provider }));
      for (const method of ['POST', 'PATCH']) {
        const input = method === 'POST' ? { ...base, textResourceId: 8 } : { textResourceId: 8 };
        const result = await server.request(method === 'POST' ? '/bibles' : '/bibles/1', {
          method,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(input),
        });
        expect(result.status).toBe(method === 'POST' ? 201 : 200);
        expect(await result.json()).toEqual({ ...response, provider });
      }
    }
  );

  it.each(['POST', 'PATCH'])(
    '%s rejects missing or invalid provider before service execution',
    async (method) => {
      for (const identity of [{ externalId: '1' }, { provider: 'other', externalId: '1' }]) {
        const result = await server.request(method === 'POST' ? '/bibles' : '/bibles/1', {
          method,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...base, ...identity }),
        });
        expect(result.status).toBe(400);
      }
      expect(bibleService.createBible).not.toHaveBeenCalled();
      expect(bibleService.updateBible).not.toHaveBeenCalled();
    }
  );
});
