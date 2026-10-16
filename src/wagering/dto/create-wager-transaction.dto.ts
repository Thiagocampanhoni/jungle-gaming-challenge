import {
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { WagerTransactionType } from '../entities/wager-transaction.entity.js';

export class CreateWagerTransactionDto {
  @IsUUID()
  walletId!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(128)
  externalTransactionId!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(128)
  idempotencyKey!: string;

  @IsEnum(WagerTransactionType)
  type!: WagerTransactionType;

  @IsString()
  @Matches(/^[A-Z]{3}$/, {
    message: 'currency deve conter um código de três letras maiúsculas',
  })
  currency!: string;

  @IsString()
  @Matches(/^(?=.*[1-9])(?:0|[1-9]\d{0,16})(?:\.\d{1,2})?$/, {
    message:
      'amount deve ser uma string decimal positiva com até 17 dígitos inteiros e duas casas decimais',
  })
  amount!: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  referenceTransactionId?: string;
}
