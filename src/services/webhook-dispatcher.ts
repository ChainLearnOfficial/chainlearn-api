import axios, { AxiosError, AxiosResponse } from 'axios';
import { logger } from '../utils/logger';
import { metrics } from '../utils/metrics';

interface WebhookDispatchResult {
    success: boolean;
    statusCode: number | null;
    error: string | null;
}

export class WebhookDispatcher {
    private static readonly TIMEOUT_MS = 10000;
    private static readonly MAX_REDIRECTS = 3;

    static async dispatch(
        webhookId: string,
        event: string,
        payload: unknown
    ): Promise<WebhookDispatchResult> {
        const startTime = Date.now();
        
        try {
            const webhook = await this.getWebhookConfig(webhookId);
            if (!webhook) {
                return {
                    success: false,
                    statusCode: 404,
                    error: 'Webhook not found'
                };
            }

            const response = await axios.post(
                webhook.url,
                { event, payload, timestamp: new Date().toISOString() },
                {
                    timeout: this.TIMEOUT_MS,
                    maxRedirects: this.MAX_REDIRECTS,
                    headers: {
                        'Content-Type': 'application/json',
                        'X-Webhook-Id': webhookId,
                        'X-Webhook-Signature': this.generateSignature(webhook.secret, payload)
                    }
                }
            );

            const duration = Date.now() - startTime;
            metrics.timing('webhook.dispatch.duration', duration);
            metrics.increment('webhook.dispatch.success', { webhookId });
            
            logger.info(`Webhook ${webhookId} dispatched successfully in ${duration}ms`);
            
            return {
                success: true,
                statusCode: response.status,
                error: null
            };
            
        } catch (error) {
            const duration = Date.now() - startTime;
            metrics.timing('webhook.dispatch.duration', duration);
            
            if (error instanceof AxiosError) {
                const statusCode = error.response?.status ?? null;
                const errorMessage = error.response?.data?.message ?? error.message;
                
                metrics.increment('webhook.dispatch.failed', {
                    webhookId,
                    statusCode: statusCode?.toString() ?? 'unknown'
                });
                
                logger.error(`Webhook dispatch failed: ${errorMessage}`, {
                    webhookId,
                    statusCode,
                    duration
                });
                
                return {
                    success: false,
                    statusCode,
                    error: errorMessage
                };
            }
            
            metrics.increment('webhook.dispatch.error', { webhookId });
            logger.error(`Webhook dispatch error: ${error}`, { webhookId, duration });
            
            return {
                success: false,
                statusCode: null,
                error: error instanceof Error ? error.message : 'Unknown error'
            };
        }
    }

    private static async getWebhookConfig(webhookId: string): Promise<{ url: string; secret: string } | null> {
        return await WebhookConfigRepository.findById(webhookId);
    }

    private static generateSignature(secret: string, payload: unknown): string {
        const data = JSON.stringify(payload);
        return require('crypto')
            .createHmac('sha256', secret)
            .update(data)
            .digest('hex');
    }
}
