import { Schema, Types } from 'mongoose';
import { ChunkType } from '../types';

/**
 * Creates the ChronicleChunk schema that wraps original documents
 * @param _payloadSchema - The original document schema to wrap (reserved for future use)
 */
export function createChronicleChunkSchema(_payloadSchema?: Schema): Schema {
  return new Schema({
    // Unique ChronicleChunk ID (auto-generated)
    _id: {
      type: Schema.Types.ObjectId,
      default: () => new Types.ObjectId(),
    },
    // Identifies the unique original document
    docId: {
      type: Schema.Types.ObjectId,
      required: true,
      index: true,
    },
    // Branch this chunk belongs to
    branchId: {
      type: Schema.Types.ObjectId,
      required: true,
      index: true,
    },
    // Sequential number within the branch
    serial: {
      type: Number,
      required: true,
      default: 1,
    },
    // Chunk type: 1 = full, 2 = delta
    ccType: {
      type: Number,
      required: true,
      enum: [ChunkType.FULL, ChunkType.DELTA],
      default: ChunkType.FULL,
    },
    // Soft delete flag
    isDeleted: {
      type: Boolean,
      required: true,
      default: false,
    },
    // Creation timestamp
    cTime: {
      type: Date,
      required: true,
      default: () => new Date(),
    },
    // The payload - original document data
    payload: {
      type: Schema.Types.Mixed,
      required: true,
    },
  }, {
    timestamps: false,
    collection: undefined, // Will be set during plugin initialization
  });
}

/**
 * Schema for Chronicle Metadata documents
 */
export const ChronicleMetadataSchema = new Schema({
  _id: {
    type: Schema.Types.ObjectId,
    default: () => new Types.ObjectId(),
  },
  docId: {
    type: Schema.Types.ObjectId,
    required: true,
    unique: true,
    index: true,
  },
  activeBranchId: {
    type: Schema.Types.ObjectId,
    required: true,
  },
  metadataStatus: {
    type: String,
    required: true,
    enum: ['pending', 'active', 'orphaned'],
    default: 'pending',
  },
}, {
  timestamps: true,
});

/**
 * Schema for Chronicle Branch documents
 */
export const ChronicleBranchSchema = new Schema({
  _id: {
    type: Schema.Types.ObjectId,
    default: () => new Types.ObjectId(),
  },
  docId: {
    type: Schema.Types.ObjectId,
    required: true,
    index: true,
  },
  parentBranchId: {
    type: Schema.Types.ObjectId,
    default: null,
  },
  parentSerial: {
    type: Number,
    default: null,
  },
  name: {
    type: String,
    required: true,
  },
}, {
  timestamps: { createdAt: true, updatedAt: false },
});

/**
 * Schema for Chronicle Configuration documents
 */
export const ChronicleConfigSchema = new Schema({
  _id: {
    type: Schema.Types.ObjectId,
    default: () => new Types.ObjectId(),
  },
  collectionName: {
    type: String,
    required: true,
    unique: true,
  },
  fullChunkInterval: {
    type: Number,
    required: true,
    default: 10,
  },
  pluginVersion: {
    type: String,
    required: true,
  },
}, {
  timestamps: true,
});

// Compound indexes for efficient queries
ChronicleMetadataSchema.index({ docId: 1, metadataStatus: 1 });
ChronicleBranchSchema.index({ docId: 1, name: 1 });
