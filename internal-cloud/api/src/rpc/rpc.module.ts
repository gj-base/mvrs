import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RpcController } from './rpc.controller';
import { RpcService } from './rpc.service';

@Module({
  imports: [AuthModule],
  controllers: [RpcController],
  providers: [RpcService],
})
export class RpcModule {}
