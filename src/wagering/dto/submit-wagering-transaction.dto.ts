import { Type } from 'class-transformer';
import {
  IsDefined,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { WagerTransactionType } from '../entities/wager-transaction.entity.js';

export class WagerMoneyDto {
  @IsString()
  @Matches(/^(?:0|[1-9]\d{0,16})\.\d{2}$/, {
    message: 'money.amount must be a fixed-scale decimal string (e.g. 25.00)',
  })
  amount!: string;

  @IsString()
  @Matches(/^[A-Z]{3}$/)
  currency!: string;
}

export class SubmitWageringTransactionDto {
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  @Matches(/\S/)
  providerId!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(128)
  @Matches(/\S/)
  externalTransactionId!: string;

  @IsUUID()
  playerId!: string;

  @IsUUID()
  walletId!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(128)
  @Matches(/\S/)
  roundId!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(128)
  @Matches(/\S/)
  gameId!: string;

  @IsEnum(WagerTransactionType)
  kind!: WagerTransactionType;

  @IsDefined()
  @ValidateNested()
  @Type(() => WagerMoneyDto)
  money!: WagerMoneyDto;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  referenceExternalTransactionId?: string;
}
