import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { LegacyFunctionsController } from './legacy-functions.controller';
import { LegacyEdgeService } from './legacy-edge.service';
import { SubmitReservationService } from './submit-reservation.service';
import { MyReservationsService } from './my-reservations.service';

@Module({
  imports: [AuthModule],
  controllers: [LegacyFunctionsController],
  providers: [LegacyEdgeService, SubmitReservationService, MyReservationsService],
})
export class LegacyFunctionsModule {}
