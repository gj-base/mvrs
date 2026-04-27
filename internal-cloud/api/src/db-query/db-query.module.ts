import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DbQueryController } from './db-query.controller';
import { DbQueryService } from './db-query.service';

@Module({
  imports: [AuthModule],
  controllers: [DbQueryController],
  providers: [DbQueryService],
})
export class DbQueryModule {}
