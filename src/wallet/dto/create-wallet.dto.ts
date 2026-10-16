import { Type } from 'class-transformer';
import {
  IsDefined,
  IsString,
  IsUUID,
  Matches,
  ValidateNested,
} from 'class-validator';

export class WalletInitialBalanceDto {
  @IsString()
  @Matches(/^(?:0|[1-9]\d{0,16})\.\d{2}$/, {
    message: 'initialBalance.amount must be a nonnegative decimal with exactly two decimal places',
  })
  amount!: string;

  @IsString()
  @Matches(/^[A-Z]{3}$/)
  currency!: string;
}

export class CreateWalletDto {
  @IsUUID()
  playerId!: string;

  @IsDefined()
  @ValidateNested()
  @Type(() => WalletInitialBalanceDto)
  initialBalance!: WalletInitialBalanceDto;
}
