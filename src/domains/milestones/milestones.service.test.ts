import { beforeEach, describe, expect, it, vi } from 'vitest';

import { db } from '@/db';
import * as biblesService from '@/domains/bibles/bibles.service';
import * as chapterAssignmentsService from '@/domains/chapter-assignments/chapter-assignments.service';
import { logger } from '@/lib/logger';
import { getQueue } from '@/lib/queue';
import { err, ErrorCode, ok } from '@/lib/types';
import { makeBible } from '@/test/utils/test-helpers';

import * as repo from './milestones.repository';
import {
  createMilestone,
  deleteMilestone,
  getMilestone,
  listMilestonesForProject,
  listMilestonesForProjects,
  updateMilestone,
} from './milestones.service';

const mockTx = { _isMockTx: true };

vi.mock('@/db', () => ({
  db: {
    transaction: vi.fn(),
  },
}));

vi.mock('@/domains/bibles/bibles.service', () => ({ getBibleRecordById: vi.fn() }));

vi.mock('@/lib/queue', () => ({
  getQueue: vi.fn(),
  QUEUE_NAMES: {
    DBL_INGEST_TEXT: 'dbl-ingest-text',
    DBL_INGEST_TEXT_PRIORITY: 'dbl-ingest-text-priority',
  },
}));

vi.mock('./milestones.repository', () => ({
  getValidBookIdsForBible: vi.fn(),
  insertMilestoneRecord: vi.fn(),
  insertBibleBookLinks: vi.fn(),
  listByProjectId: vi.fn(),
  listSummariesByProjectIds: vi.fn(),
  getMilestoneById: vi.fn(),
  getByIdForProject: vi.fn(),
  updateMilestoneRecord: vi.fn(),
  moveBookToMilestone: vi.fn(),
  getExistingBookAssignmentsForProject: vi.fn(),
  deleteBibleBookLinks: vi.fn(),
  deleteMilestoneRecord: vi.fn(),
  getBooksByIds: vi.fn(),
}));

vi.mock('@/domains/chapter-assignments/chapter-assignments.service', () => ({
  createChapterAssignmentForProjectUnit: vi.fn(),
}));

vi.mock('@/domains/projects/projects.service', () => ({
  lockProjectById: vi.fn().mockResolvedValue(true),
}));

vi.mock('@/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

describe('milestones service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(biblesService.getBibleRecordById).mockResolvedValue(ok(makeBible()));
    vi.mocked(db.transaction).mockImplementation(async (cb) => cb(mockTx as any));
  });

  describe('createMilestone', () => {
    const mockInput = {
      name: 'New Milestone',
      type: 'text' as const,
      status: 'not_started' as const,
      bookIds: [1, 2],
    };

    it('should create milestone successfully', async () => {
      const mockMilestone = { id: 200, projectId: 100 } as any;

      vi.mocked(repo.getValidBookIdsForBible).mockResolvedValue([1, 2]);
      vi.mocked(repo.insertMilestoneRecord).mockResolvedValue(mockMilestone);
      vi.mocked(repo.insertBibleBookLinks).mockResolvedValue(undefined);
      vi.mocked(repo.getExistingBookAssignmentsForProject).mockResolvedValue([]);
      vi.mocked(repo.getBooksByIds).mockResolvedValue([]);
      vi.mocked(chapterAssignmentsService.createChapterAssignmentForProjectUnit).mockResolvedValue(
        ok([])
      );
      vi.mocked(repo.getByIdForProject).mockResolvedValue(mockMilestone);

      const result = await createMilestone(100, 10, mockInput as any);

      expect(repo.getValidBookIdsForBible).toHaveBeenCalledWith(10, [1, 2]);
      expect(repo.insertMilestoneRecord).toHaveBeenCalledWith(
        100,
        { name: 'New Milestone', type: 'text', status: 'not_started' },
        mockTx
      );
      expect(repo.insertBibleBookLinks).toHaveBeenCalledWith(
        [
          { projectUnitId: 200, bibleId: 10, bookId: 1 },
          { projectUnitId: 200, bibleId: 10, bookId: 2 },
        ],
        mockTx
      );
      expect(chapterAssignmentsService.createChapterAssignmentForProjectUnit).toHaveBeenCalledWith(
        200,
        10,
        [1, 2],
        mockTx
      );

      expect(result).toEqual(ok(mockMilestone));
    });

    it('should return INVALID_BIBLE_BOOKS if any book is invalid', async () => {
      vi.mocked(repo.getValidBookIdsForBible).mockResolvedValue([1]);

      const result = await createMilestone(100, 10, mockInput as any);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCode.INVALID_BIBLE_BOOKS);
      }

      expect(db.transaction).not.toHaveBeenCalled();
      expect(repo.insertMilestoneRecord).not.toHaveBeenCalled();
    });

    it('should rollback (return error) if cross-domain assignment fails', async () => {
      const mockMilestone = { id: 200 } as any;

      vi.mocked(repo.getValidBookIdsForBible).mockResolvedValue([1, 2]);
      vi.mocked(repo.insertMilestoneRecord).mockResolvedValue(mockMilestone);
      vi.mocked(repo.getExistingBookAssignmentsForProject).mockResolvedValue([]);
      vi.mocked(repo.getBooksByIds).mockResolvedValue([]);

      vi.mocked(chapterAssignmentsService.createChapterAssignmentForProjectUnit).mockResolvedValue(
        err(ErrorCode.INTERNAL_ERROR)
      );

      const result = await createMilestone(100, 10, mockInput as any);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCode.INTERNAL_ERROR);
      }
    });
  });

  describe('updateMilestone', () => {
    it('should update milestone successfully', async () => {
      const mockUpdatedMilestone = { id: 1, name: 'Updated' } as any;
      vi.mocked(repo.getByIdForProject).mockResolvedValue(mockUpdatedMilestone);
      vi.mocked(repo.updateMilestoneRecord).mockResolvedValue(mockUpdatedMilestone);
      vi.mocked(repo.getExistingBookAssignmentsForProject).mockResolvedValue([]);
      vi.mocked(repo.getBooksByIds).mockResolvedValue([]);

      const result = await updateMilestone(100, 1, { name: 'Updated' }, null);

      expect(repo.updateMilestoneRecord).toHaveBeenCalledWith(1, { name: 'Updated' }, mockTx);
      expect(result).toEqual(ok(mockUpdatedMilestone));
    });

    it('should return NOT_FOUND if milestone record does not exist', async () => {
      vi.mocked(repo.getByIdForProject).mockResolvedValue(undefined as any);

      const result = await updateMilestone(100, 999, { name: 'Updated' }, null);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCode.NOT_FOUND);
      }
    });

    it('should move books if requested', async () => {
      const mockUpdatedMilestone = { id: 1, projectId: 100, name: 'Updated', bookIds: [2] } as any;
      vi.mocked(repo.getByIdForProject).mockResolvedValue(mockUpdatedMilestone);
      vi.mocked(repo.updateMilestoneRecord).mockResolvedValue(mockUpdatedMilestone);
      vi.mocked(repo.getExistingBookAssignmentsForProject).mockResolvedValue([]);
      vi.mocked(repo.getBooksByIds).mockResolvedValue([]);
      vi.mocked(repo.getMilestoneById).mockResolvedValue({ id: 3, projectId: 100 } as any);
      vi.mocked(repo.moveBookToMilestone).mockResolvedValue(undefined);

      const result = await updateMilestone(
        100,
        1,
        {
          moveBooks: [{ bookId: 2, targetMilestoneId: 3 }],
        },
        null
      );

      expect(repo.moveBookToMilestone).toHaveBeenCalledWith(2, 1, 3, mockTx);
      expect(result).toEqual(ok(mockUpdatedMilestone));
    });
  });

  describe('passthrough reads and deletes', () => {
    it('listMilestonesForProject should call repo', async () => {
      const mockResult = [{ id: 1 }] as any;
      vi.mocked(repo.listByProjectId).mockResolvedValue(mockResult);

      const result = await listMilestonesForProject(100);
      expect(repo.listByProjectId).toHaveBeenCalledWith(100);
      expect(result).toEqual(ok(mockResult));
    });

    it('listMilestonesForProjects should call repo', async () => {
      const mockResult = [{ id: 1 }, { id: 2 }] as any;
      vi.mocked(repo.listSummariesByProjectIds).mockResolvedValue(mockResult);

      const result = await listMilestonesForProjects([3, 7]);
      expect(repo.listSummariesByProjectIds).toHaveBeenCalledWith([3, 7]);
      expect(result).toEqual(ok(mockResult));
    });

    it('getMilestone should call repo', async () => {
      const mockResult = { id: 1 } as any;
      vi.mocked(repo.getByIdForProject).mockResolvedValue(mockResult);

      const result = await getMilestone(100, 1);
      expect(repo.getByIdForProject).toHaveBeenCalledWith(100, 1);
      expect(result).toEqual(ok(mockResult));
    });

    it('getMilestone should return NOT_FOUND if missing', async () => {
      vi.mocked(repo.getByIdForProject).mockResolvedValue(undefined as any);

      const result = await getMilestone(100, 1);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCode.NOT_FOUND);
      }
    });

    it('deleteMilestone should call repo to delete', async () => {
      vi.mocked(repo.getByIdForProject).mockResolvedValue({ id: 1 } as any);
      vi.mocked(repo.deleteMilestoneRecord).mockResolvedValue(undefined);

      const result = await deleteMilestone(100, 1);
      expect(repo.deleteMilestoneRecord).toHaveBeenCalledWith(1, mockTx);
      expect(result).toEqual(ok(undefined));
    });
  });
});

describe('milestone ingestion provider dispatch', () => {
  const row = {
    id: 200,
    projectId: 100,
    name: 'Milestone',
    status: 'not_started' as const,
    type: 'text' as const,
    connectivityProfile: null,
    createdAt: null,
    updatedAt: null,
  };
  const enriched = {
    ...row,
    projectName: 'Project',
    milestoneCount: 1,
    bookCount: 1,
    bookIds: [1],
    chapterStatusCounts: {},
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.transaction).mockImplementation(async (cb) => cb(mockTx as never));
    vi.mocked(repo.getValidBookIdsForBible).mockResolvedValue([1]);
    vi.mocked(repo.insertMilestoneRecord).mockResolvedValue(row);
    vi.mocked(repo.getExistingBookAssignmentsForProject).mockResolvedValue([]);
    vi.mocked(repo.getByIdForProject).mockResolvedValue(enriched);
    vi.mocked(repo.getBooksByIds).mockResolvedValue([{ id: 1, code: 'GEN' }]);
    vi.mocked(chapterAssignmentsService.createChapterAssignmentForProjectUnit).mockResolvedValue(
      ok([])
    );
  });

  it.each(['create', 'update'] as const)(
    '%s propagates identity lookup errors before any transaction',
    async (operation) => {
      vi.mocked(biblesService.getBibleRecordById).mockResolvedValue(err(ErrorCode.INTERNAL_ERROR));
      const result =
        operation === 'create'
          ? await createMilestone(100, 1, {
              name: 'Milestone',
              type: 'text',
              status: 'not_started',
              bookIds: [1],
            })
          : await updateMilestone(100, 200, { addBooks: [1] }, 1);
      expect(result).toEqual(err(ErrorCode.INTERNAL_ERROR));
      expect(db.transaction).not.toHaveBeenCalled();
      expect(getQueue).not.toHaveBeenCalled();
    }
  );

  it.each(['aquifer', 'youversion', 'dbl'] as const)(
    'guards both create and update dispatch for %s',
    async (provider) => {
      vi.mocked(biblesService.getBibleRecordById).mockResolvedValue(ok(makeBible({ provider })));
      const send = vi.fn();
      const { boss } = (await import('@/test/utils/test-helpers')).fakeBoss();
      vi.spyOn(boss, 'send').mockImplementation(send);
      vi.mocked(getQueue).mockResolvedValue(boss);
      expect(
        (
          await createMilestone(100, 1, {
            name: 'Milestone',
            type: 'text',
            status: 'not_started',
            bookIds: [1],
          })
        ).ok
      ).toBe(true);
      expect((await updateMilestone(100, 200, { addBooks: [1] }, 1)).ok).toBe(true);
      if (provider === 'dbl') {
        expect(send).toHaveBeenCalledTimes(2);
        expect(send).toHaveBeenCalledWith(
          'dbl-ingest-text-priority',
          expect.objectContaining({ bibleId: 1, bookCodes: ['GEN'] }),
          { priority: 10 }
        );
      } else {
        expect(getQueue).not.toHaveBeenCalled();
        expect(send).not.toHaveBeenCalled();
        expect(logger.warn).toHaveBeenCalledTimes(2);
      }
    }
  );
});
