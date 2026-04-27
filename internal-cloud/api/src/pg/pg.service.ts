import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';

@Injectable()
export class PgService implements OnModuleDestroy {
  readonly pool: Pool;

  constructor(private readonly config: ConfigService) {
    const url = this.config.get<string>('DATABASE_URL');
    if (!url) {
      throw new Error('DATABASE_URL is required');
    }
    this.pool = new Pool({ connectionString: url, max: 20 });
  }

  async onModuleDestroy() {
    await this.pool.end();
  }
}
