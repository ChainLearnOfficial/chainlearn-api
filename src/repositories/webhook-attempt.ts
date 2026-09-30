import { prisma } from '../utils/prisma';

export class WebhookAttemptRepository {
    static async findDueForRetry(): Promise<any[]> {
        return prisma.webhookAttempt.findMany({
            where: {
                nextRetryAt: { lte: new Date() },
                succeededAt: null,
                failedAt: null
            },
            orderBy: { nextRetryAt: 'asc' }
        });
    }

    static async markSucceeded(id: string, succeededAt: Date): Promise<void> {
        await prisma.webhookAttempt.update({
            where: { id },
            data: { succeededAt, retryCount: { increment: 1 } }
        });
    }

    static async markFailed(id: string, failedAt: Date, errorMessage: string | null): Promise<void> {
        await prisma.webhookAttempt.update({
            where: { id },
            data: { failedAt, errorMessage, retryCount: { increment: 1 } }
        });
    }

    static async updateRetry(id: string, retryCount: number, nextRetryAt: Date): Promise<void> {
        await prisma.webhookAttempt.update({
            where: { id },
            data: { retryCount, nextRetryAt }
        });
    }

    static async create(webhookId: string, event: string, payload: unknown): Promise<any> {
        return prisma.webhookAttempt.create({
            data: {
                webhookId,
                event,
                payload,
                retryCount: 0,
                nextRetryAt: new Date()
            }
        });
    }
}
