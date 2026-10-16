import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { CreateWalletDto } from './dto/create-wallet.dto.js';
import {
  WalletService,
  type LedgerPage,
  type ReconciliationResponse,
  type WalletResponse,
} from './wallet.service.js';

@Controller('wallets')
export class WalletController {
  constructor(private readonly wallets: WalletService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(@Body() dto: CreateWalletDto): Promise<WalletResponse> {
    return this.wallets.create(dto);
  }

  @Get(':walletId')
  findOne(
    @Param('walletId', new ParseUUIDPipe()) walletId: string,
  ): Promise<WalletResponse> {
    return this.wallets.findOne(walletId);
  }

  @Get(':walletId/ledger')
  ledger(
    @Param('walletId', new ParseUUIDPipe()) walletId: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ): Promise<LedgerPage> {
    return this.wallets.ledger(walletId, limit, cursor);
  }

  @Post(':walletId/reconciliation')
  @HttpCode(HttpStatus.OK)
  reconcile(
    @Param('walletId', new ParseUUIDPipe()) walletId: string,
  ): Promise<ReconciliationResponse> {
    return this.wallets.reconcile(walletId);
  }
}
