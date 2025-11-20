import { Type } from 'class-transformer';
import { IsArray, IsString, ValidateNested } from 'class-validator';
import { BulkImportRowDto } from './bulk-import-row.dto';

export class BulkImportDto {
  @IsString()
  organizationId: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => BulkImportRowDto)
  rows: BulkImportRowDto[];
}
