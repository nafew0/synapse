import { pipeline } from 'stream/promises';
import { GridFSBucket, ObjectId } from 'mongodb';
import type { Db, Filter, GridFSFile } from 'mongodb';
import type { Readable } from 'stream';
import type { PhoneUploadFile } from 'librechat-data-provider';

export const PHONE_UPLOAD_BUCKET = 'phoneuploads';

/** Who a staged file belongs to: the handoff session and the desktop user that opened it. */
export interface PhoneUploadOwner {
  sessionId: string;
  userId: string;
}

interface StagedMetadata extends PhoneUploadOwner {
  mimeType: string;
}

export interface PhoneUploadInput {
  filename: string;
  mimeType: string;
  stream: Readable;
}

export interface PhoneUploadDownload {
  file: PhoneUploadFile;
  stream: Readable;
}

export interface PhoneUploadStore {
  save(owner: PhoneUploadOwner, input: PhoneUploadInput): Promise<PhoneUploadFile>;
  list(owner: PhoneUploadOwner): Promise<PhoneUploadFile[]>;
  count(owner: PhoneUploadOwner): Promise<number>;
  open(owner: PhoneUploadOwner, fileId: string): Promise<PhoneUploadDownload | null>;
  remove(owner: PhoneUploadOwner, fileId: string): Promise<boolean>;
  removeSession(owner: PhoneUploadOwner): Promise<number>;
  /** Deletes files staged before `cutoff`, left behind by sessions nobody closed. */
  sweep(cutoff: Date): Promise<number>;
}

const ownerFilter = (owner: PhoneUploadOwner): Filter<GridFSFile> => ({
  'metadata.sessionId': owner.sessionId,
  'metadata.userId': owner.userId,
});

const toObjectId = (fileId: string): ObjectId | null =>
  ObjectId.isValid(fileId) ? new ObjectId(fileId) : null;

const toFile = (doc: GridFSFile): PhoneUploadFile => {
  const metadata = doc.metadata as StagedMetadata | undefined;
  return {
    fileId: doc._id.toString(),
    filename: doc.filename,
    mimeType: metadata?.mimeType ?? 'application/octet-stream',
    bytes: doc.length,
    uploadedAt: doc.uploadDate.toISOString(),
  };
};

/**
 * Temporary store for files sent from a phone, held in GridFS so every API instance sees them
 * until the desktop collects them.
 */
export function createPhoneUploadStore(db: Db): PhoneUploadStore {
  const bucket = new GridFSBucket(db, { bucketName: PHONE_UPLOAD_BUCKET });
  const files = db.collection<GridFSFile>(`${PHONE_UPLOAD_BUCKET}.files`);

  const deleteAll = async (docs: GridFSFile[]): Promise<number> => {
    const results = await Promise.allSettled(docs.map((doc) => bucket.delete(doc._id)));
    return results.filter((result) => result.status === 'fulfilled').length;
  };

  const findOwned = (owner: PhoneUploadOwner, fileId: string): Promise<GridFSFile | null> => {
    const _id = toObjectId(fileId);
    if (!_id) {
      return Promise.resolve(null);
    }
    return files.findOne({ _id, ...ownerFilter(owner) });
  };

  return {
    async save(owner, input) {
      const metadata: StagedMetadata = { ...owner, mimeType: input.mimeType };
      const upload = bucket.openUploadStream(input.filename, { metadata });
      try {
        await pipeline(input.stream, upload);
      } catch (error) {
        await bucket.delete(upload.id).catch(() => undefined);
        throw error;
      }
      return {
        fileId: upload.id.toString(),
        filename: input.filename,
        mimeType: input.mimeType,
        bytes: upload.length,
        uploadedAt: new Date().toISOString(),
      };
    },

    async list(owner) {
      const docs = await files.find(ownerFilter(owner)).sort({ uploadDate: 1 }).toArray();
      return docs.map(toFile);
    },

    count(owner) {
      return files.countDocuments(ownerFilter(owner));
    },

    async open(owner, fileId) {
      const doc = await findOwned(owner, fileId);
      if (!doc) {
        return null;
      }
      return { file: toFile(doc), stream: bucket.openDownloadStream(doc._id) };
    },

    async remove(owner, fileId) {
      const doc = await findOwned(owner, fileId);
      if (!doc) {
        return false;
      }
      await bucket.delete(doc._id);
      return true;
    },

    async removeSession(owner) {
      return deleteAll(await files.find(ownerFilter(owner)).toArray());
    },

    async sweep(cutoff) {
      return deleteAll(await files.find({ uploadDate: { $lt: cutoff } }).toArray());
    },
  };
}
