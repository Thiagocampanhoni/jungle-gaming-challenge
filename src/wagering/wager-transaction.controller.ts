import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
} from '@nestjs/common';
import { CreateWagerTransactionDto } from './dto/create-wager-transaction.dto.js';
import { SubmitWageringTransactionDto } from './dto/submit-wagering-transaction.dto.js';
import {
  WagerTransactionIntakeService,
  type WagerTransactionSubmission,
} from './wager-transaction-intake-service.js';

@Controller()
export class WagerTransactionController {
  constructor(private readonly intakeService: WagerTransactionIntakeService) {}

  /** Kept for backward compatibility with already persisted legacy requests. */
  @Post('wager-transactions')
  @HttpCode(HttpStatus.ACCEPTED)
  async submitLegacy(
    @Body() dto: CreateWagerTransactionDto,
  ): Promise<WagerTransactionSubmission> {
    return this.intakeService.submit(dto);
  }

  @Post('wagering/transactions')
  @HttpCode(HttpStatus.ACCEPTED)
  async submitProvider(
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() dto: SubmitWageringTransactionDto,
  ): Promise<{
    transactionId: string;
    status: string;
    idempotentReplay: boolean;
  }> {
    if (
      !idempotencyKey ||
      idempotencyKey.trim() !== idempotencyKey ||
      idempotencyKey.length > 128
    ) {
      throw new BadRequestException('Valid Idempotency-Key header is required');
    }

    const result = await this.intakeService.submitProvider(dto, idempotencyKey);
    return {
      transactionId: result.transactionId,
      status: result.status === 'APPLIED' ? 'PROCESSED' : result.status,
      idempotentReplay: result.duplicate,
    };
  }
}
