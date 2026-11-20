import { Model } from 'mongoose';
import type { IKbDocumentDoc, IKbDocumentVersionDoc, IKbIngestJobDoc } from '~/types';
import { kbDocumentSchema, kbDocumentVersionSchema, kbIngestJobSchema } from '~/schema/kb';
import { applyTenantIsolation } from '~/models/plugins/tenantIsolation';

export function createKbDocumentModel(mongoose: typeof import('mongoose')): Model<IKbDocumentDoc> {
  applyTenantIsolation(kbDocumentSchema);
  return (
    mongoose.models.KbDocument ||
    mongoose.model<IKbDocumentDoc>('KbDocument', kbDocumentSchema, 'kbdocuments')
  );
}

export function createKbDocumentVersionModel(
  mongoose: typeof import('mongoose'),
): Model<IKbDocumentVersionDoc> {
  applyTenantIsolation(kbDocumentVersionSchema);
  return (
    mongoose.models.KbDocumentVersion ||
    mongoose.model<IKbDocumentVersionDoc>(
      'KbDocumentVersion',
      kbDocumentVersionSchema,
      'kbdocumentversions',
    )
  );
}

export function createKbIngestJobModel(
  mongoose: typeof import('mongoose'),
): Model<IKbIngestJobDoc> {
  applyTenantIsolation(kbIngestJobSchema);
  return (
    mongoose.models.KbIngestJob ||
    mongoose.model<IKbIngestJobDoc>('KbIngestJob', kbIngestJobSchema, 'kbingestjobs')
  );
}
