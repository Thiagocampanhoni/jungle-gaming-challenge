import { Controller, Get, Res } from '@nestjs/common';
import type { Response } from 'express';
import { MetricsService } from './metrics.service.js';

@Controller('metrics')
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Get()
  async getMetrics(@Res({ passthrough: true }) response: Response): Promise<string> {
    // Only mark successful Prometheus scrapes as text/plain.
    // When collect() throws HTTP 503, Nest's JSON exception response retains
    // its correct application/json Content-Type.
    const payload = await this.metrics.collect();
    response.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    return payload;
  }
}
