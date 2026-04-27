import { All, Body, Controller, Param, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { LegacyEdgeService } from './legacy-edge.service';

@Controller('functions')
export class LegacyFunctionsController {
  constructor(private readonly edge: LegacyEdgeService) {}

  @All(':name')
  async invoke(
    @Param('name') name: string,
    @Req() req: Request,
    @Res() res: Response,
    @Body() body: unknown,
  ) {
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
      res.setHeader(
        'Access-Control-Allow-Headers',
        'authorization, x-client-info, apikey, content-type, x-admin-secret, x-supabase-api-version, prefer',
      );
      return res.status(204).send();
    }
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method not allowed' });
    }
    res.setHeader('Access-Control-Allow-Origin', '*');
    await this.edge.dispatch(name, req, res, body);
  }
}
