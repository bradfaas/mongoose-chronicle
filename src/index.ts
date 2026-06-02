/**
 * mongoose-chronicle
 * A Mongoose plugin for granular document history, branching, and snapshot capabilities
 */

export { chroniclePlugin, initializeChronicle } from './core/plugin';
export {
  createChronicleChunkSchema,
  createChronicleKeysSchema,
  ChronicleMetadataSchema,
  ChronicleBranchSchema,
  ChronicleConfigSchema,
} from './core/schemas';
export {
  computeDelta,
  applyDelta,
  applyDeltas,
  isDeltaEmpty,
} from './utils/delta';
export {
  analyzeSchemaIndexes,
  createCleanPayloadSchema,
  generateChronicleIndexes,
} from './utils/schema-analyzer';
export type {
  FieldIndexInfo,
  CompoundIndexInfo,
  SchemaIndexAnalysis,
} from './utils/schema-analyzer';
export {
  ChroniclePluginOptions,
  ChunkType,
  ChronicleChunk,
  ChronicleMetadata,
  ChronicleBranch,
  ChronicleConfig,
  ChronicleKeys,
  ChronicleQueryOptions,
  ChronicleDocument,
  ChronicleModel,
} from './types';

// Default export for convenient usage
export { chroniclePlugin as default } from './core/plugin';
