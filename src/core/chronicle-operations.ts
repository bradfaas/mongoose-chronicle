import { Types, Connection, Document } from 'mongoose';
import type { ChroniclePluginOptions, ChunkType } from '../types';
import { computeDelta, isDeltaEmpty } from '../utils/delta';

/**
 * Error thrown when a unique constraint violation is detected
 */
export class ChronicleUniqueConstraintError extends Error {
  public field: string;
  public value: unknown;

  constructor(field: string, value: unknown) {
    super(`Duplicate key error: ${field} "${value}" already exists`);
    this.name = 'ChronicleUniqueConstraintError';
    this.field = field;
    this.value = value;
  }
}

/**
 * Context for chronicle operations, passed to middleware
 */
export interface ChronicleContext {
  connection: Connection;
  /** The base collection name (original model collection) */
  baseCollectionName: string;
  /** The collection name for chronicle chunks */
  chunksCollectionName: string;
  options: ChroniclePluginOptions;
  uniqueFields: string[];
  indexedFields: string[];
}

/**
 * Result of looking up or creating chronicle metadata for a document
 */
export interface ChronicleDocumentState {
  docId: Types.ObjectId;
  branchId: Types.ObjectId;
  currentSerial: number;
  isNew: boolean;
  previousPayload?: Record<string, unknown>;
}

/**
 * Validates that unique fields don't conflict with existing documents
 * @param ctx - Chronicle context
 * @param payload - The document payload to validate
 * @param excludeDocId - DocId to exclude from check (for updates)
 * @param branchId - Branch to check uniqueness within
 */
export async function validateUniqueConstraints(
  ctx: ChronicleContext,
  payload: Record<string, unknown>,
  branchId: Types.ObjectId,
  excludeDocId?: Types.ObjectId
): Promise<void> {
  if (ctx.uniqueFields.length === 0) {
    return;
  }

  const keysCollectionName = `${ctx.baseCollectionName}_chronicle_keys`;
  const keysCollection = ctx.connection.db?.collection(keysCollectionName);

  if (!keysCollection) {
    return; // Keys collection doesn't exist, skip validation
  }

  for (const field of ctx.uniqueFields) {
    const value = payload[field];

    // Skip if value is null/undefined (sparse unique)
    if (value === null || value === undefined) {
      continue;
    }

    // Build query to find conflicting documents
    const query: Record<string, unknown> = {
      [`key_${field}`]: value,
      branchId,
      isDeleted: false,
    };

    // Exclude current document when updating
    if (excludeDocId) {
      query.docId = { $ne: excludeDocId };
    }

    const existing = await keysCollection.findOne(query);

    if (existing) {
      throw new ChronicleUniqueConstraintError(field, value);
    }
  }
}

/**
 * Updates the chronicle keys collection with new unique key values
 * @param ctx - Chronicle context
 * @param docId - Document ID
 * @param branchId - Branch ID
 * @param payload - The full document payload
 * @param isDeleted - Whether the document is being deleted
 */
export async function updateChronicleKeys(
  ctx: ChronicleContext,
  docId: Types.ObjectId,
  branchId: Types.ObjectId,
  payload: Record<string, unknown>,
  isDeleted = false
): Promise<void> {
  if (ctx.uniqueFields.length === 0) {
    return;
  }

  const keysCollectionName = `${ctx.baseCollectionName}_chronicle_keys`;
  const keysCollection = ctx.connection.db?.collection(keysCollectionName);

  if (!keysCollection) {
    return;
  }

  // Build the key document
  const keyDoc: Record<string, unknown> = {
    docId,
    branchId,
    isDeleted,
    updatedAt: new Date(),
  };

  // Add each unique field value
  for (const field of ctx.uniqueFields) {
    keyDoc[`key_${field}`] = payload[field] ?? null;
  }

  // Upsert the keys document
  await keysCollection.updateOne(
    { docId, branchId },
    {
      $set: keyDoc,
      $setOnInsert: { createdAt: new Date() },
    },
    { upsert: true }
  );
}

/**
 * Marks previous chunks as not latest
 * @param ctx - Chronicle context
 * @param docId - Document ID
 * @param branchId - Branch ID
 */
export async function clearIsLatestFlag(
  ctx: ChronicleContext,
  docId: Types.ObjectId,
  branchId: Types.ObjectId
): Promise<void> {
  const chunksCollection = ctx.connection.db?.collection(ctx.chunksCollectionName);

  if (!chunksCollection) {
    return;
  }

  await chunksCollection.updateMany(
    { docId, branchId, isLatest: true },
    { $set: { isLatest: false } }
  );
}

/**
 * Gets or creates the chronicle metadata for a document
 * @param ctx - Chronicle context
 * @param docId - Document ID (MongoDB _id - Mongoose assigns this before save even for new docs)
 * @param isNew - Whether this is a new document being created
 * @returns The document state including branch and serial info
 */
export async function getOrCreateDocumentState(
  ctx: ChronicleContext,
  docId: Types.ObjectId,
  isNew: boolean
): Promise<ChronicleDocumentState> {
  const metadataCollectionName = ctx.options.metadataCollectionName ??
    `${ctx.baseCollectionName}_chronicle_metadata`;
  const branchCollectionName = `${ctx.baseCollectionName}_chronicle_branches`;

  const metadataCollection = ctx.connection.db?.collection(metadataCollectionName);
  const branchCollection = ctx.connection.db?.collection(branchCollectionName);
  const chunksCollection = ctx.connection.db?.collection(ctx.chunksCollectionName);

  if (!metadataCollection || !branchCollection || !chunksCollection) {
    throw new Error('Chronicle collections not initialized');
  }

  // For new documents - use the MongoDB _id as the chronicle docId
  // This ensures consistency between the document's _id and chronicle tracking
  if (isNew) {
    const newBranchId = new Types.ObjectId();

    // Create the main branch using the document's _id
    await branchCollection.insertOne({
      _id: newBranchId,
      docId: docId, // Use the MongoDB _id
      parentBranchId: null,
      parentSerial: null,
      name: 'main',
      createdAt: new Date(),
    });

    // Create metadata pointing to main branch
    await metadataCollection.insertOne({
      _id: new Types.ObjectId(),
      docId: docId, // Use the MongoDB _id
      activeBranchId: newBranchId,
      metadataStatus: 'pending',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    return {
      docId: docId, // Return the MongoDB _id
      branchId: newBranchId,
      currentSerial: 0,
      isNew: true,
    };
  }

  // For existing documents - look up by the MongoDB _id
  const metadata = await metadataCollection.findOne({ docId });

  if (!metadata) {
    throw new Error(`Chronicle metadata not found for document ${docId}`);
  }

  // Get the latest chunk to find current serial
  const latestChunk = await chunksCollection.findOne(
    { docId, branchId: metadata.activeBranchId, isLatest: true },
    { projection: { serial: 1, payload: 1 } }
  );

  // If there's a latest chunk, we need to rehydrate to get full payload
  let previousPayload: Record<string, unknown> | undefined;
  if (latestChunk) {
    previousPayload = await rehydrateDocument(ctx, docId, metadata.activeBranchId as Types.ObjectId);
  }

  return {
    docId,
    branchId: metadata.activeBranchId as Types.ObjectId,
    currentSerial: (latestChunk?.serial as number) ?? 0,
    isNew: false,
    previousPayload,
  };
}

/**
 * Rehydrates a document from its chunks
 * @param ctx - Chronicle context
 * @param docId - Document ID
 * @param branchId - Branch ID
 * @param asOf - Optional timestamp for point-in-time query
 */
export async function rehydrateDocument(
  ctx: ChronicleContext,
  docId: Types.ObjectId,
  branchId: Types.ObjectId,
  asOf?: Date
): Promise<Record<string, unknown> | undefined> {
  const chunksCollection = ctx.connection.db?.collection(ctx.chunksCollectionName);

  if (!chunksCollection) {
    return undefined;
  }

  // Build query for chunks
  const query: Record<string, unknown> = { docId, branchId };
  if (asOf) {
    query.cTime = { $lte: asOf };
  }

  // Get chunks ordered by serial
  const chunks = await chunksCollection
    .find(query)
    .sort({ serial: 1 })
    .toArray();

  if (chunks.length === 0) {
    return undefined;
  }

  // Find the most recent full chunk
  let fullChunkIndex = -1;
  for (let i = chunks.length - 1; i >= 0; i--) {
    if (chunks[i]?.ccType === 1) { // FULL
      fullChunkIndex = i;
      break;
    }
  }

  if (fullChunkIndex === -1) {
    // No full chunk found, this shouldn't happen
    return undefined;
  }

  // Start with the full chunk's payload
  let result = { ...(chunks[fullChunkIndex]?.payload as Record<string, unknown>) };

  // Apply subsequent deltas
  for (let i = fullChunkIndex + 1; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (chunk?.ccType === 2) { // DELTA
      const delta = chunk.payload as Record<string, unknown>;
      for (const [key, value] of Object.entries(delta)) {
        if (value === null) {
          delete result[key];
        } else {
          result[key] = value;
        }
      }
    }
  }

  return result;
}

/**
 * Creates a new chronicle chunk
 * @param ctx - Chronicle context
 * @param state - Document state from getOrCreateDocumentState
 * @param payload - The document payload (full or delta)
 * @param ccType - Chunk type (1=FULL, 2=DELTA)
 * @param isDeleted - Whether this marks a deletion
 */
export async function createChronicleChunk(
  ctx: ChronicleContext,
  state: ChronicleDocumentState,
  payload: Record<string, unknown>,
  ccType: ChunkType,
  isDeleted = false
): Promise<Types.ObjectId> {
  const chunksCollection = ctx.connection.db?.collection(ctx.chunksCollectionName);

  if (!chunksCollection) {
    throw new Error('Chronicle collection not initialized');
  }

  const chunkId = new Types.ObjectId();
  const newSerial = state.currentSerial + 1;

  // Clear isLatest on previous chunks
  await clearIsLatestFlag(ctx, state.docId, state.branchId);

  // Insert the new chunk
  await chunksCollection.insertOne({
    _id: chunkId,
    docId: state.docId,
    branchId: state.branchId,
    serial: newSerial,
    ccType,
    isDeleted,
    isLatest: true,
    cTime: new Date(),
    payload,
  });

  return chunkId;
}

/**
 * Determines whether to write a full chunk or delta based on the interval
 * @param currentSerial - Current serial number
 * @param fullChunkInterval - Configured interval for full chunks
 */
export function shouldWriteFullChunk(
  currentSerial: number,
  fullChunkInterval: number
): boolean {
  // Always write full for first chunk
  if (currentSerial === 0) {
    return true;
  }

  // Write full every N chunks
  return (currentSerial + 1) % fullChunkInterval === 0;
}

/**
 * Finalizes the chronicle operation by updating metadata status
 * @param ctx - Chronicle context
 * @param docId - Document ID
 */
export async function finalizeChronicleOperation(
  ctx: ChronicleContext,
  docId: Types.ObjectId
): Promise<void> {
  const metadataCollectionName = ctx.options.metadataCollectionName ??
    `${ctx.baseCollectionName}_chronicle_metadata`;
  const metadataCollection = ctx.connection.db?.collection(metadataCollectionName);

  if (!metadataCollection) {
    return;
  }

  await metadataCollection.updateOne(
    { docId },
    {
      $set: {
        metadataStatus: 'active',
        updatedAt: new Date(),
      },
    }
  );
}

/**
 * Processes a document save operation for chronicle
 * @param ctx - Chronicle context
 * @param doc - The mongoose document being saved
 * @param isNew - Whether this is a new document
 */
export async function processChroniclesSave(
  ctx: ChronicleContext,
  doc: Document,
  isNew: boolean
): Promise<{ docId: Types.ObjectId; chunkId: Types.ObjectId }> {
  const payload = doc.toObject({ getters: false, virtuals: false });
  delete payload._id;
  delete payload.__v;

  // Get or create document state
  // Always pass doc._id - Mongoose assigns _id before save even for new documents
  // This ensures chronicle docId matches the MongoDB _id for consistent lookups
  const state = await getOrCreateDocumentState(
    ctx,
    doc._id as Types.ObjectId,
    isNew
  );

  // Validate unique constraints
  await validateUniqueConstraints(
    ctx,
    payload,
    state.branchId,
    isNew ? undefined : state.docId
  );

  // Determine chunk type and payload
  const fullChunkInterval = ctx.options.fullChunkInterval ?? 10;
  let chunkPayload: Record<string, unknown>;
  let chunkType: ChunkType;

  if (shouldWriteFullChunk(state.currentSerial, fullChunkInterval)) {
    // Write full chunk
    chunkPayload = payload;
    chunkType = 1; // FULL
  } else {
    // Write delta chunk
    const delta = computeDelta(state.previousPayload ?? {}, payload);

    if (isDeltaEmpty(delta)) {
      // No changes, skip writing
      return { docId: state.docId, chunkId: new Types.ObjectId() };
    }

    chunkPayload = delta;
    chunkType = 2; // DELTA
  }

  // Create the chunk
  const chunkId = await createChronicleChunk(
    ctx,
    state,
    chunkPayload,
    chunkType
  );

  // Update chronicle keys for unique fields
  await updateChronicleKeys(ctx, state.docId, state.branchId, payload);

  // Finalize the operation
  await finalizeChronicleOperation(ctx, state.docId);

  return { docId: state.docId, chunkId };
}
