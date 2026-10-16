import { describe, expect, it, vi } from 'vitest';
import type { Response } from 'express';
import { MetricsController } from './metrics.controller.js';
import type { MetricsService } from './metrics.service.js';

function makeResponse() {
  const setHeader = vi.fn();
  return { response: { setHeader } as unknown as Response, setHeader };
}

describe('MetricsController', () => {
  it('returns Prometheus text with the text/plain content type on success', async () => {
    const collect = vi.fn().mockResolvedValue('# TYPE jungle_test gauge\njungle_test 1\n');
    const controller = new MetricsController({ collect } as unknown as MetricsService);
    const { response, setHeader } = makeResponse();

    expect(await controller.getMetrics(response)).toContain('jungle_test 1');
    expect(collect).toHaveBeenCalledOnce();
    expect(setHeader).toHaveBeenCalledWith(
      'Content-Type',
      'text/plain; version=0.0.4; charset=utf-8',
    );
  });

  it('does not force Prometheus content type when collection fails', async () => {
    const collect = vi.fn().mockRejectedValue(new Error('SQS unavailable'));
    const controller = new MetricsController({ collect } as unknown as MetricsService);
    const { response, setHeader } = makeResponse();

    await expect(controller.getMetrics(response)).rejects.toThrow('SQS unavailable');
    expect(setHeader).not.toHaveBeenCalled();
  });
});
