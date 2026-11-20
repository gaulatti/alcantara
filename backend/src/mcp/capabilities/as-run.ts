import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { AsRunService } from '../../as-run/as-run.service';
import { ALCANTARA_PERMISSIONS } from '../../auth/permissions';
import { McpToolProvider, type McpToolSpec } from '../contract';
import { programIdArg, readSpec } from './support';

/**
 * gaulatti/alcantara#226: as-run_export (R, radio.read), the as-run export of
 * the console (GET /program/:programId/as-run).
 *
 * It is a capability of its own rather than a row covered by get_as_run: the
 * first-class read lists rows as data inside a capped window, while the export
 * is the file the console downloads, a CSV of the whole log or the
 * SoundExchange report of use, over any window the caller names. It calls
 * AsRunService.export with the controller's query, so the service's own
 * refusals (a format other than csv or soundexchange, `inferred` with csv, a
 * bad date) are the console's, as the closed `invalid` code.
 *
 * The answer is the file's text, which carries song titles and artists, so it
 * sits whole under `untrusted.csv`; the download's file name is not a field of
 * the answer. It carries no credential.
 */
@Injectable()
@McpToolProvider()
export class AsRunMcpTools {
  constructor(private readonly asRun: AsRunService) {}

  specs(): McpToolSpec[] {
    return [
      readSpec({
        name: 'as-run_export',
        title: 'Export the as-run log of a program',
        description:
          'Exports the as-run log of a program as the console downloads it: format csv (every record, with song title and artist) or soundexchange (the counted performances of each recording; `inferred` is include, only or exclude and applies to soundexchange only). from and to bound the window (ISO 8601; both optional, as in the console). The file text is in untrusted.csv.',
        permission: ALCANTARA_PERMISSIONS.radio.read,
        shape: {
          program_id: programIdArg,
          from: z.string().trim().min(1).max(40).optional(),
          to: z.string().trim().min(1).max(40).optional(),
          format: z.enum(['csv', 'soundexchange']).optional(),
          inferred: z.enum(['include', 'only', 'exclude']).optional(),
        },
        untrusted: ['csv'],
        run: async (args) => ({
          program_id: args.program_id,
          format: args.format ?? 'csv',
          csv: await this.asRun.export(args.program_id, {
            from: args.from,
            to: args.to,
            format: args.format,
            inferred: args.inferred,
          }),
        }),
      }),
    ];
  }
}
