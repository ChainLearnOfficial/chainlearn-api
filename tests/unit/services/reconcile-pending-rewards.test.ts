import { describe, it, expect, vi, beforeEach } from 'vitest';
import { reconcilePendingRewards } from '../../../src/services/reconciliation';

// Use vi.hoisted to ensure mocks are initialized before hoisting
const mockUpdate = vi.fn();
const mockDb = {
  update: mockUpdate
};

const mockDatabase = vi.hoisted(() => ({
  db: mockDb
}));

vi.mock('../../../src/config/database', () => mockDatabase());

const mockGetPendingRewards = vi.fn();
const mockProcessReward = vi.fn();

vi.mock('../../../src/services/reward-service', () => ({
  getPendingRewards: mockGetPendingRewards,
  processReward: mockProcessReward
}));

describe('reconcilePendingRewards', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should process all pending rewards', async () => {
    const mockRewards = [
      { id: 1, userId: 'user1', amount: 100 },
      { id: 2, userId: 'user2', amount: 200 }
    ];

    mockGetPendingRewards.mockResolvedValue(mockRewards);
    mockProcessReward.mockResolvedValue(true);
    mockUpdate.mockResolvedValue({ rows: [] });

    await reconcilePendingRewards();

    expect(mockGetPendingRewards).toHaveBeenCalledTimes(1);
    expect(mockProcessReward).toHaveBeenCalledTimes(2);
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.stringContaining('rewards'),
      expect.any(Object)
    );
  });

  it('should handle empty rewards list', async () => {
    mockGetPendingRewards.mockResolvedValue([]);

    await reconcilePendingRewards();

    expect(mockProcessReward).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('should handle reward processing errors', async () => {
    const mockRewards = [{ id: 1, userId: 'user1', amount: 100 }];

    mockGetPendingRewards.mockResolvedValue(mockRewards);
    mockProcessReward.mockRejectedValue(new Error('Processing failed'));

    await expect(reconcilePendingRewards()).rejects.toThrow('Processing failed');
    expect(mockUpdate).not.toHaveBeenCalled();
  });
});
