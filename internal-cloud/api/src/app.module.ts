import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PgModule } from './pg/pg.module';
import { AuthModule } from './auth/auth.module';
import { DbQueryModule } from './db-query/db-query.module';
import { RpcModule } from './rpc/rpc.module';
import { LegacyFunctionsModule } from './legacy-functions/legacy-functions.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PgModule,
    AuthModule,
    DbQueryModule,
    RpcModule,
    LegacyFunctionsModule,
  ],
})
export class AppModule {}
