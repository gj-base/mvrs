import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { LegacyFunctionsController } from './legacy-functions.controller';
import { LegacyEdgeService } from './legacy-edge.service';
import { SubmitReservationService } from './submit-reservation.service';

@Module({
  imports: [AuthModule],
  controllers: [LegacyFunctionsController],
  providers: [LegacyEdgeService, SubmitReservationService],
})
export class LegacyFunctionsModule {}
