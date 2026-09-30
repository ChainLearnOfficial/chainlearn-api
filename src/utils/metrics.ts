import { Counter, Gauge, Histogram } from 'prom-client';

const register = new Registry();

export const metrics = {
    webhook: {
        success: new Counter({
            name: 'webhook_success_total',
            help: 'Total number of successful webhook deliveries',
            registers: [register]
        }),
        failed: new Counter({
            name: 'webhook_failed_total',
            help: 'Total number of failed webhook deliveries',
            labelNames: ['type'],
            registers: [register]
        }),
        retry: new Counter({
            name: 'webhook_retry_total',
            help: 'Total number of webhook retry attempts',
            registers: [register]
        }),
        error: new Counter({
            name: 'webhook_error_total',
            help: 'Total number of webhook processing errors',
            registers: [register]
        }),
        dispatch: {
            success: new Counter({
                name: 'webhook_dispatch_success_total',
                help: 'Total number of successful webhook dispatches',
                labelNames: ['webhookId'],
                registers: [register]
            }),
            failed: new Counter({
                name: 'webhook_dispatch_failed_total',
                help: 'Total number of failed webhook dispatches',
                labelNames: ['webhookId', 'statusCode'],
                registers: [register]
            }),
            error: new Counter({
                name: 'webhook_dispatch_error_total',
                help: 'Total number of webhook dispatch errors',
                labelNames: ['webhookId'],
                registers: [register]
            }),
            duration: new Histogram({
                name: 'webhook_dispatch_duration_ms',
                help: 'Duration of webhook dispatch operations in milliseconds',
                buckets: [10, 50, 100, 500, 1000, 5000, 10000],
                registers: [register]
            })
        }
    }
};

export function getMetrics(): Promise<string> {
    return register.metrics();
}
