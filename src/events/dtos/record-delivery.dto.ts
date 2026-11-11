import {
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';
import {
  DELIVERY_CHANNELS,
  DELIVERY_FEATURES,
  DELIVERY_SOURCES,
  type DeliveryChannel,
  type DeliveryFeature,
  type DeliverySource,
} from '../schemas/message-delivery.schema';

/** El navegador avisa que le mostró un mensaje al asistente */
export class RecordDeliveryDto {
  @IsIn(DELIVERY_FEATURES)
  feature!: DeliveryFeature;

  @IsIn(DELIVERY_CHANNELS)
  channel!: DeliveryChannel;

  @IsOptional()
  @IsIn(DELIVERY_SOURCES)
  source?: DeliverySource;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  groupKey?: string;

  @IsOptional()
  @IsString()
  @Matches(/^[\w:.-]{1,80}$/)
  refId?: string;
}
