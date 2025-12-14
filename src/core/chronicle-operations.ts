import { Types, type Connection, type Document } from 'mongoose';
import type {
  ChroniclePluginOptions,
  ChunkType,
  ChronicleBranch,
  CreateBranchOptions,
  RevertOptions,
  RevertResult,
  SquashOptions,
  SquashResult,
  SquashDryRunResult,
  AsOfOptions,
  AsOfResult,
  UndeleteOptions,
  UndeleteResult,
  ListDeletedFilters,
  DeletedDocInfo,
  PurgeOptions,
  PurgeResult,
} from '../types';
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
  epoch: number;
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
    const epoch = 1;

    // Create the main branch using the document's _id
    await branchCollection.insertOne({
      _id: newBranchId,
      docId: docId, // Use the MongoDB _id
      epoch,
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
      epoch,
      metadataStatus: 'pending',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    return {
      docId: docId, // Return the MongoDB _id
      branchId: newBranchId,
      epoch,
      currentSerial: 0,
      isNew: true,
    };
  }

  // For existing documents - look up by the MongoDB _id
  // Find the latest (highest epoch) metadata for this docId
  const metadata = await metadataCollection.findOne(
    { docId },
    { sort: { epoch: -1 } }
  );

  if (!metadata) {
    throw new Error(`Chronicle metadata not found for document ${docId}`);
  }

  const epoch = (metadata.epoch as number) ?? 1;

  // Get the latest chunk to find current serial
  const latestChunk = await chunksCollection.findOne(
    { docId, epoch, branchId: metadata.activeBranchId, isLatest: true },
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
    epoch,
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

  // Insert the new chunk with epoch
  await chunksCollection.insertOne({
    _id: chunkId,
    docId: state.docId,
    epoch: state.epoch,
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

/**
 * Creates a new branch for a document
 * @param ctx - Chronicle context
 * @param docId - Document ID
 * @param branchName - Name for the new branch
 * @param options - Branch creation options
 * @returns The created branch
 */
export async function createBranch(
  ctx: ChronicleContext,
  docId: Types.ObjectId,
  branchName: string,
  options: CreateBranchOptions = {}
): Promise<ChronicleBranch> {
  const { activate = true, fromSerial } = options;

  const metadataCollectionName = ctx.options.metadataCollectionName ??
    `${ctx.baseCollectionName}_chronicle_metadata`;
  const branchCollectionName = `${ctx.baseCollectionName}_chronicle_branches`;

  const metadataCollection = ctx.connection.db?.collection(metadataCollectionName);
  const branchCollection = ctx.connection.db?.collection(branchCollectionName);
  const chunksCollection = ctx.connection.db?.collection(ctx.chunksCollectionName);

  if (!metadataCollection || !branchCollection || !chunksCollection) {
    throw new Error('Chronicle collections not initialized');
  }

  // Get current metadata to find active branch
  const metadata = await metadataCollection.findOne({ docId });
  if (!metadata) {
    throw new Error(`Chronicle metadata not found for document ${docId}`);
  }

  const parentBranchId = metadata.activeBranchId as Types.ObjectId;
  const epoch = (metadata.epoch as number) ?? 1;

  // Determine the serial to branch from
  let parentSerial: number;
  if (fromSerial !== undefined) {
    // Verify the specified serial exists
    const chunk = await chunksCollection.findOne({
      docId,
      branchId: parentBranchId,
      serial: fromSerial,
    });
    if (!chunk) {
      throw new Error(`Serial ${fromSerial} not found on current branch`);
    }
    parentSerial = fromSerial;
  } else {
    // Use the latest serial
    const latestChunk = await chunksCollection.findOne(
      { docId, branchId: parentBranchId, isLatest: true },
      { projection: { serial: 1 } }
    );
    if (!latestChunk) {
      throw new Error('No chunks found for document on current branch');
    }
    parentSerial = latestChunk.serial as number;
  }

  // Create the new branch
  const newBranchId = new Types.ObjectId();
  const now = new Date();

  const branchDoc: ChronicleBranch = {
    _id: newBranchId,
    docId,
    epoch,
    parentBranchId,
    parentSerial,
    name: branchName,
    createdAt: now,
  };

  await branchCollection.insertOne(branchDoc);

  // Rehydrate the document state at the branch point
  const documentState = await rehydrateDocumentAtSerial(
    ctx,
    docId,
    parentBranchId,
    parentSerial
  );

  if (!documentState) {
    throw new Error('Failed to rehydrate document state at branch point');
  }

  // Create a FULL chunk for the new branch with the state at the branch point
  await chunksCollection.insertOne({
    _id: new Types.ObjectId(),
    docId,
    epoch,
    branchId: newBranchId,
    serial: 1,
    ccType: 1, // FULL
    isDeleted: false,
    isLatest: true,
    cTime: now,
    payload: documentState,
  });

  // Activate the branch if requested (default: true)
  if (activate) {
    await metadataCollection.updateOne(
      { docId },
      { $set: { activeBranchId: newBranchId, updatedAt: now } }
    );
  }

  return branchDoc;
}

/**
 * Rehydrates a document at a specific serial number
 * @param ctx - Chronicle context
 * @param docId - Document ID
 * @param branchId - Branch ID
 * @param serial - Serial number to rehydrate to
 */
async function rehydrateDocumentAtSerial(
  ctx: ChronicleContext,
  docId: Types.ObjectId,
  branchId: Types.ObjectId,
  serial: number
): Promise<Record<string, unknown> | undefined> {
  const chunksCollection = ctx.connection.db?.collection(ctx.chunksCollectionName);

  if (!chunksCollection) {
    return undefined;
  }

  // Get all chunks up to and including the target serial
  const chunks = await chunksCollection
    .find({ docId, branchId, serial: { $lte: serial } })
    .sort({ serial: 1 })
    .toArray();

  if (chunks.length === 0) {
    return undefined;
  }

  // Find the most recent full chunk at or before target serial
  let fullChunkIndex = -1;
  for (let i = chunks.length - 1; i >= 0; i--) {
    if (chunks[i]?.ccType === 1) { // FULL
      fullChunkIndex = i;
      break;
    }
  }

  if (fullChunkIndex === -1) {
    return undefined;
  }

  // Start with the full chunk's payload
  const result = { ...(chunks[fullChunkIndex]?.payload as Record<string, unknown>) };

  // Apply subsequent deltas up to target serial
  for (let i = fullChunkIndex + 1; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (chunk?.ccType === 2) { // DELTA
      const delta = chunk.payload as Record<string, unknown>;
      for (const [key, value] of Object.entries(delta)) {
        if (value === null) {
          // Use undefined assignment to remove the key (avoids delete operator)
          (result as Record<string, unknown>)[key] = undefined;
        } else {
          result[key] = value;
        }
      }
    }
  }

  // Clean up undefined values
  for (const key of Object.keys(result)) {
    if (result[key] === undefined) {
      const { [key]: _, ...rest } = result;
      Object.assign(result, rest);
      // Actually remove the key
      Reflect.deleteProperty(result, key);
    }
  }

  return result;
}

/**
 * Switches the active branch for a document
 * @param ctx - Chronicle context
 * @param docId - Document ID
 * @param branchId - Branch ID to switch to
 */
export async function switchBranch(
  ctx: ChronicleContext,
  docId: Types.ObjectId,
  branchId: Types.ObjectId
): Promise<void> {
  const metadataCollectionName = ctx.options.metadataCollectionName ??
    `${ctx.baseCollectionName}_chronicle_metadata`;
  const branchCollectionName = `${ctx.baseCollectionName}_chronicle_branches`;

  const metadataCollection = ctx.connection.db?.collection(metadataCollectionName);
  const branchCollection = ctx.connection.db?.collection(branchCollectionName);

  if (!metadataCollection || !branchCollection) {
    throw new Error('Chronicle collections not initialized');
  }

  // Verify the branch exists and belongs to this document
  const branch = await branchCollection.findOne({ _id: branchId, docId });
  if (!branch) {
    throw new Error(`Branch ${branchId} not found for document ${docId}`);
  }

  // Update the active branch
  const result = await metadataCollection.updateOne(
    { docId },
    { $set: { activeBranchId: branchId, updatedAt: new Date() } }
  );

  if (result.matchedCount === 0) {
    throw new Error(`Chronicle metadata not found for document ${docId}`);
  }
}

/**
 * Lists all branches for a document
 * @param ctx - Chronicle context
 * @param docId - Document ID
 * @returns Array of branches
 */
export async function listBranches(
  ctx: ChronicleContext,
  docId: Types.ObjectId
): Promise<ChronicleBranch[]> {
  const branchCollectionName = `${ctx.baseCollectionName}_chronicle_branches`;
  const branchCollection = ctx.connection.db?.collection(branchCollectionName);

  if (!branchCollection) {
    throw new Error('Chronicle collections not initialized');
  }

  const branches = await branchCollection
    .find({ docId })
    .sort({ createdAt: 1 })
    .toArray();

  return branches as unknown as ChronicleBranch[];
}

/**
 * Gets the currently active branch for a document
 * @param ctx - Chronicle context
 * @param docId - Document ID
 * @returns The active branch or null if not found
 */
export async function getActiveBranch(
  ctx: ChronicleContext,
  docId: Types.ObjectId
): Promise<ChronicleBranch | null> {
  const metadataCollectionName = ctx.options.metadataCollectionName ??
    `${ctx.baseCollectionName}_chronicle_metadata`;
  const branchCollectionName = `${ctx.baseCollectionName}_chronicle_branches`;

  const metadataCollection = ctx.connection.db?.collection(metadataCollectionName);
  const branchCollection = ctx.connection.db?.collection(branchCollectionName);

  if (!metadataCollection || !branchCollection) {
    return null;
  }

  const metadata = await metadataCollection.findOne({ docId });
  if (!metadata) {
    return null;
  }

  const branch = await branchCollection.findOne({ _id: metadata.activeBranchId });
  return branch as unknown as ChronicleBranch | null;
}

/**
 * Reverts a branch's history to a specific serial, removing all chunks newer than the target.
 * This operation only affects the specified branch and does not touch other branches.
 *
 * @param ctx - Chronicle context
 * @param docId - Document ID
 * @param serial - The serial number to revert to (becomes the new "latest")
 * @param options - Revert options
 * @returns Result containing success status, counts, and optionally the rehydrated state
 */
export async function chronicleRevert(
  ctx: ChronicleContext,
  docId: Types.ObjectId,
  serial: number,
  options: RevertOptions = {}
): Promise<RevertResult> {
  const { rehydrate = true } = options;

  const metadataCollectionName = ctx.options.metadataCollectionName ??
    `${ctx.baseCollectionName}_chronicle_metadata`;
  const branchCollectionName = `${ctx.baseCollectionName}_chronicle_branches`;

  const metadataCollection = ctx.connection.db?.collection(metadataCollectionName);
  const branchCollection = ctx.connection.db?.collection(branchCollectionName);
  const chunksCollection = ctx.connection.db?.collection(ctx.chunksCollectionName);

  if (!metadataCollection || !branchCollection || !chunksCollection) {
    throw new Error('Chronicle collections not initialized');
  }

  // Determine target branch
  let branchId: Types.ObjectId;
  if (options.branchId) {
    branchId = options.branchId;
  } else {
    const metadata = await metadataCollection.findOne({ docId });
    if (!metadata) {
      throw new Error(`Chronicle metadata not found for document ${docId}`);
    }
    branchId = metadata.activeBranchId as Types.ObjectId;
  }

  // Validate the target serial exists
  const targetChunk = await chunksCollection.findOne({
    docId,
    branchId,
    serial,
  });

  if (!targetChunk) {
    throw new Error(`Serial ${serial} not found on branch ${branchId}`);
  }

  // Check if target is already latest (no-op)
  const latestChunk = await chunksCollection.findOne({
    docId,
    branchId,
    isLatest: true,
  });

  if (latestChunk && latestChunk.serial === serial) {
    // Target is already latest, return early
    let state: Record<string, unknown> | undefined;
    if (rehydrate) {
      state = await rehydrateDocumentAtSerial(ctx, docId, branchId, serial);
    }
    return {
      success: true,
      revertedToSerial: serial,
      chunksRemoved: 0,
      branchesUpdated: 0,
      state,
    };
  }

  // Delete all chunks with serial > targetSerial on this branch
  const deleteResult = await chunksCollection.deleteMany({
    docId,
    branchId,
    serial: { $gt: serial },
  });

  const chunksRemoved = deleteResult.deletedCount;

  // Update the target chunk to set isLatest: true
  await chunksCollection.updateOne(
    { docId, branchId, serial },
    { $set: { isLatest: true } }
  );

  // Update orphaned branches: branches where parentBranchId === branchId AND parentSerial > serial
  const branchUpdateResult = await branchCollection.updateMany(
    {
      docId,
      parentBranchId: branchId,
      parentSerial: { $gt: serial },
    },
    { $set: { parentSerial: serial } }
  );

  const branchesUpdated = branchUpdateResult.modifiedCount;

  // Rehydrate if requested
  let state: Record<string, unknown> | undefined;
  if (rehydrate) {
    state = await rehydrateDocumentAtSerial(ctx, docId, branchId, serial);
  }

  return {
    success: true,
    revertedToSerial: serial,
    chunksRemoved,
    branchesUpdated,
    state,
  };
}

/**
 * Squashes all chronicle history into a single FULL chunk representing a chosen point in time.
 * This is a destructive, irreversible operation that removes all branches and history.
 *
 * @param ctx - Chronicle context
 * @param docId - Document ID
 * @param serial - The serial number to use as the new base state
 * @param options - Squash options (confirm must be true to execute)
 * @returns Result containing success status, previous counts, and the new state
 */
export async function chronicleSquash(
  ctx: ChronicleContext,
  docId: Types.ObjectId,
  serial: number,
  options: SquashOptions
): Promise<SquashResult | SquashDryRunResult> {
  const { confirm, dryRun = false } = options;

  // Safety check - require explicit confirmation unless dry run
  if (!dryRun && confirm !== true) {
    throw new Error('Squash requires explicit confirmation. Set options.confirm = true to execute.');
  }

  const metadataCollectionName = ctx.options.metadataCollectionName ??
    `${ctx.baseCollectionName}_chronicle_metadata`;
  const branchCollectionName = `${ctx.baseCollectionName}_chronicle_branches`;

  const metadataCollection = ctx.connection.db?.collection(metadataCollectionName);
  const branchCollection = ctx.connection.db?.collection(branchCollectionName);
  const chunksCollection = ctx.connection.db?.collection(ctx.chunksCollectionName);

  if (!metadataCollection || !branchCollection || !chunksCollection) {
    throw new Error('Chronicle collections not initialized');
  }

  // Determine target branch
  let branchId: Types.ObjectId;
  if (options.branchId) {
    branchId = options.branchId;
  } else {
    const metadata = await metadataCollection.findOne({ docId });
    if (!metadata) {
      throw new Error(`Chronicle metadata not found for document ${docId}`);
    }
    branchId = metadata.activeBranchId as Types.ObjectId;
  }

  // Validate the target serial exists
  const targetChunk = await chunksCollection.findOne({
    docId,
    branchId,
    serial,
  });

  if (!targetChunk) {
    throw new Error(`Serial ${serial} not found on branch ${branchId}`);
  }

  // Count existing chunks and branches
  const previousChunkCount = await chunksCollection.countDocuments({ docId });
  const previousBranchCount = await branchCollection.countDocuments({ docId });

  // Rehydrate the document state at the target serial
  const newBaseState = await rehydrateDocumentAtSerial(ctx, docId, branchId, serial);

  if (!newBaseState) {
    throw new Error('Failed to rehydrate document state at specified serial');
  }

  // If dry run, return preview without making changes
  if (dryRun) {
    return {
      wouldDelete: {
        chunks: previousChunkCount,
        branches: previousBranchCount - 1, // All except the new main
      },
      newBaseState,
    };
  }

  // Delete ALL chunks for this document
  await chunksCollection.deleteMany({ docId });

  // Delete ALL branches for this document
  await branchCollection.deleteMany({ docId });

  // Create new main branch
  const newBranchId = new Types.ObjectId();
  const now = new Date();
  // After squash, reset to epoch 1
  const newEpoch = 1;

  await branchCollection.insertOne({
    _id: newBranchId,
    docId,
    epoch: newEpoch,
    parentBranchId: null,
    parentSerial: null,
    name: 'main',
    createdAt: now,
  });

  // Create a new FULL chunk with serial 1
  await chunksCollection.insertOne({
    _id: new Types.ObjectId(),
    docId,
    epoch: newEpoch,
    branchId: newBranchId,
    serial: 1,
    ccType: 1, // FULL
    isDeleted: false,
    isLatest: true,
    cTime: now,
    payload: newBaseState,
  });

  // Update metadata to point to new main branch and reset epoch
  await metadataCollection.updateOne(
    { docId },
    {
      $set: {
        activeBranchId: newBranchId,
        epoch: newEpoch,
        metadataStatus: 'active',
        updatedAt: now,
      },
    }
  );

  return {
    success: true,
    previousChunkCount,
    previousBranchCount,
    newState: newBaseState,
  };
}

/**
 * Gets the document state at a specific point in time.
 * Rehydrates the document from chunks created at or before the given timestamp.
 *
 * @param ctx - Chronicle context
 * @param docId - Document ID
 * @param asOf - The timestamp to query
 * @param options - Query options (branchId or searchAllBranches)
 * @returns Result containing found status, state, and metadata
 */
export async function chronicleAsOf(
  ctx: ChronicleContext,
  docId: Types.ObjectId,
  asOf: Date,
  options: AsOfOptions = {}
): Promise<AsOfResult> {
  const { branchId: optionBranchId, searchAllBranches = false } = options;

  // Validate mutually exclusive options
  if (optionBranchId && searchAllBranches) {
    throw new Error('branchId and searchAllBranches are mutually exclusive');
  }

  const metadataCollectionName = ctx.options.metadataCollectionName ??
    `${ctx.baseCollectionName}_chronicle_metadata`;
  const branchCollectionName = `${ctx.baseCollectionName}_chronicle_branches`;

  const metadataCollection = ctx.connection.db?.collection(metadataCollectionName);
  const branchCollection = ctx.connection.db?.collection(branchCollectionName);
  const chunksCollection = ctx.connection.db?.collection(ctx.chunksCollectionName);

  if (!metadataCollection || !branchCollection || !chunksCollection) {
    throw new Error('Chronicle collections not initialized');
  }

  if (searchAllBranches) {
    // Cross-branch search: find the branch with the most recent chunk at or before asOf
    return chronicleAsOfAllBranches(ctx, docId, asOf, chunksCollection, branchCollection);
  }

  // Single branch query
  let branchId: Types.ObjectId;
  if (optionBranchId) {
    branchId = optionBranchId;
  } else {
    // Use active branch
    const metadata = await metadataCollection.findOne({ docId });
    if (!metadata) {
      return { found: false };
    }
    branchId = metadata.activeBranchId as Types.ObjectId;
  }

  return chronicleAsOfSingleBranch(ctx, docId, asOf, branchId, chunksCollection);
}

/**
 * Helper function for single-branch asOf query
 */
async function chronicleAsOfSingleBranch(
  _ctx: ChronicleContext,
  docId: Types.ObjectId,
  asOf: Date,
  branchId: Types.ObjectId,
  chunksCollection: ReturnType<NonNullable<Connection['db']>['collection']>
): Promise<AsOfResult> {
  // Build query for chunks at or before the asOf timestamp
  const query = {
    docId,
    branchId,
    cTime: { $lte: asOf },
  };

  // Get chunks ordered by serial ascending
  const chunks = await chunksCollection
    .find(query)
    .sort({ serial: 1 })
    .toArray();

  if (chunks.length === 0) {
    return { found: false };
  }

  // Find the most recent FULL chunk
  let fullChunkIndex = -1;
  for (let i = chunks.length - 1; i >= 0; i--) {
    if (chunks[i]?.ccType === 1) { // FULL
      fullChunkIndex = i;
      break;
    }
  }

  if (fullChunkIndex === -1) {
    // No full chunk found before asOf
    return { found: false };
  }

  // Start with the full chunk's payload
  const state: Record<string, unknown> = { ...(chunks[fullChunkIndex]?.payload as Record<string, unknown>) };

  // Apply subsequent deltas
  for (let i = fullChunkIndex + 1; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (chunk?.ccType === 2) { // DELTA
      const delta = chunk.payload as Record<string, unknown>;
      for (const [key, value] of Object.entries(delta)) {
        if (value === null) {
          delete state[key];
        } else {
          state[key] = value;
        }
      }
    }
  }

  // Get the last chunk for metadata (most recent chunk at or before asOf)
  const lastChunk = chunks[chunks.length - 1];

  return {
    found: true,
    state,
    serial: lastChunk?.serial as number,
    branchId,
    chunkTimestamp: lastChunk?.cTime as Date,
  };
}

/**
 * Helper function for cross-branch asOf query (searchAllBranches: true)
 */
async function chronicleAsOfAllBranches(
  ctx: ChronicleContext,
  docId: Types.ObjectId,
  asOf: Date,
  chunksCollection: ReturnType<NonNullable<Connection['db']>['collection']>,
  branchCollection: ReturnType<NonNullable<Connection['db']>['collection']>
): Promise<AsOfResult> {
  // Get all branches for this document
  const branches = await branchCollection.find({ docId }).toArray();

  if (branches.length === 0) {
    return { found: false };
  }

  // For each branch, find the most recent chunk at or before asOf
  interface BranchCandidate {
    branchId: Types.ObjectId;
    latestCTime: Date;
  }

  const candidates: BranchCandidate[] = [];

  for (const branch of branches) {
    const latestChunk = await chunksCollection.findOne(
      {
        docId,
        branchId: branch._id,
        cTime: { $lte: asOf },
      },
      {
        sort: { cTime: -1 },
        projection: { cTime: 1 },
      }
    );

    if (latestChunk) {
      candidates.push({
        branchId: branch._id as Types.ObjectId,
        latestCTime: latestChunk.cTime as Date,
      });
    }
  }

  if (candidates.length === 0) {
    return { found: false };
  }

  // Find the branch with the most recent chunk
  let best = candidates[0];
  for (let i = 1; i < candidates.length; i++) {
    const candidate = candidates[i];
    if (candidate && best && candidate.latestCTime > best.latestCTime) {
      best = candidate;
    }
  }

  if (!best) {
    return { found: false };
  }

  // Rehydrate from the winning branch
  return chronicleAsOfSingleBranch(ctx, docId, asOf, best.branchId, chunksCollection);
}

/**
 * Performs a soft delete on a document by creating a deletion chunk.
 * The document's chronicle history is preserved, and the isDeleted flag is set to true.
 * This also marks the chronicle_keys entry as deleted to release unique constraints.
 *
 * @param ctx - Chronicle context
 * @param docId - Document ID to soft delete
 * @returns Result containing the deletion chunk ID and final state
 */
export async function chronicleSoftDelete(
  ctx: ChronicleContext,
  docId: Types.ObjectId
): Promise<{ chunkId: Types.ObjectId; finalState: Record<string, unknown> }> {
  const metadataCollectionName = ctx.options.metadataCollectionName ??
    `${ctx.baseCollectionName}_chronicle_metadata`;

  const metadataCollection = ctx.connection.db?.collection(metadataCollectionName);
  const chunksCollection = ctx.connection.db?.collection(ctx.chunksCollectionName);

  if (!metadataCollection || !chunksCollection) {
    throw new Error('Chronicle collections not initialized');
  }

  // Get the current document state
  const metadata = await metadataCollection.findOne(
    { docId },
    { sort: { epoch: -1 } }
  );

  if (!metadata) {
    throw new Error(`Chronicle metadata not found for document ${docId}`);
  }

  const branchId = metadata.activeBranchId as Types.ObjectId;
  const epoch = (metadata.epoch as number) ?? 1;

  // Get the latest chunk to find current serial and payload
  const latestChunk = await chunksCollection.findOne(
    { docId, epoch, branchId, isLatest: true },
    { projection: { serial: 1, payload: 1, isDeleted: 1 } }
  );

  if (!latestChunk) {
    throw new Error(`No chunks found for document ${docId} on active branch`);
  }

  // Check if already deleted
  if (latestChunk.isDeleted) {
    throw new Error(`Document ${docId} is already deleted`);
  }

  // Rehydrate the final state before deletion
  const finalState = await rehydrateDocument(ctx, docId, branchId);
  if (!finalState) {
    throw new Error(`Failed to rehydrate document ${docId} for deletion`);
  }

  // Create the document state for chunk creation
  const state: ChronicleDocumentState = {
    docId,
    branchId,
    epoch,
    currentSerial: latestChunk.serial as number,
    isNew: false,
    previousPayload: finalState,
  };

  // Create a deletion chunk (FULL chunk with isDeleted: true)
  // The payload contains the final state at time of deletion
  const chunkId = await createChronicleChunk(
    ctx,
    state,
    finalState,
    1, // FULL chunk
    true // isDeleted
  );

  // Mark the chronicle_keys entry as deleted to release unique constraints
  await updateChronicleKeys(ctx, docId, branchId, finalState, true);

  return { chunkId, finalState };
}

/**
 * Restores a soft-deleted document by creating a new chunk that marks it as not deleted.
 * Optionally can restore to a specific epoch if multiple deletion cycles have occurred.
 *
 * @param ctx - Chronicle context
 * @param docId - Document ID to restore
 * @param options - Undelete options
 * @returns Result containing success status and restored state
 */
export async function chronicleUndelete(
  ctx: ChronicleContext,
  docId: Types.ObjectId,
  options: UndeleteOptions = {}
): Promise<UndeleteResult> {
  const metadataCollectionName = ctx.options.metadataCollectionName ??
    `${ctx.baseCollectionName}_chronicle_metadata`;

  const metadataCollection = ctx.connection.db?.collection(metadataCollectionName);
  const chunksCollection = ctx.connection.db?.collection(ctx.chunksCollectionName);

  if (!metadataCollection || !chunksCollection) {
    throw new Error('Chronicle collections not initialized');
  }

  // Determine which epoch to restore
  let targetEpoch: number;
  if (options.epoch !== undefined) {
    targetEpoch = options.epoch;
  } else {
    // Find the latest epoch for this document
    const metadata = await metadataCollection.findOne(
      { docId },
      { sort: { epoch: -1 } }
    );
    if (!metadata) {
      throw new Error(`Chronicle metadata not found for document ${docId}`);
    }
    targetEpoch = (metadata.epoch as number) ?? 1;
  }

  // Get metadata for the target epoch
  const metadata = await metadataCollection.findOne({ docId, epoch: targetEpoch });
  if (!metadata) {
    throw new Error(`Chronicle metadata not found for document ${docId} at epoch ${targetEpoch}`);
  }

  const branchId = options.branchId ?? (metadata.activeBranchId as Types.ObjectId);

  // Get the latest chunk to verify it's deleted
  const latestChunk = await chunksCollection.findOne(
    { docId, epoch: targetEpoch, branchId, isLatest: true },
    { projection: { serial: 1, payload: 1, isDeleted: 1 } }
  );

  if (!latestChunk) {
    throw new Error(`No chunks found for document ${docId} at epoch ${targetEpoch}`);
  }

  if (!latestChunk.isDeleted) {
    throw new Error(`Document ${docId} at epoch ${targetEpoch} is not deleted`);
  }

  // The deletion chunk contains the final state - use that as the restored state
  const restoredState = latestChunk.payload as Record<string, unknown>;

  // Validate unique constraints for the restored state
  await validateUniqueConstraints(ctx, restoredState, branchId, docId);

  // Create the document state for chunk creation
  const state: ChronicleDocumentState = {
    docId,
    branchId,
    epoch: targetEpoch,
    currentSerial: latestChunk.serial as number,
    isNew: false,
    previousPayload: restoredState,
  };

  // Create a restoration chunk (FULL chunk with isDeleted: false)
  await createChronicleChunk(
    ctx,
    state,
    restoredState,
    1, // FULL chunk
    false // isDeleted: false (restored)
  );

  // Update chronicle_keys to mark as not deleted
  await updateChronicleKeys(ctx, docId, branchId, restoredState, false);

  return {
    success: true,
    docId,
    epoch: targetEpoch,
    restoredState,
  };
}

/**
 * Lists all soft-deleted documents for this collection.
 *
 * @param ctx - Chronicle context
 * @param filters - Optional filters for the query
 * @returns Array of deleted document info
 */
export async function chronicleListDeleted(
  ctx: ChronicleContext,
  filters: ListDeletedFilters = {}
): Promise<DeletedDocInfo[]> {
  const chunksCollection = ctx.connection.db?.collection(ctx.chunksCollectionName);

  if (!chunksCollection) {
    throw new Error('Chronicle collections not initialized');
  }

  // Build query for deleted documents using the partial index
  const query: Record<string, unknown> = {
    isLatest: true,
    isDeleted: true,
  };

  // Add time filters if provided
  if (filters.deletedAfter || filters.deletedBefore) {
    query.cTime = {};
    if (filters.deletedAfter) {
      (query.cTime as Record<string, unknown>).$gt = filters.deletedAfter;
    }
    if (filters.deletedBefore) {
      (query.cTime as Record<string, unknown>).$lt = filters.deletedBefore;
    }
  }

  // Query for all deleted chunks (using the partial index on isLatest + isDeleted)
  const deletedChunks = await chunksCollection
    .find(query)
    .sort({ cTime: -1 })
    .toArray();

  // Transform to DeletedDocInfo format
  return deletedChunks.map(chunk => ({
    docId: chunk.docId as Types.ObjectId,
    epoch: (chunk.epoch as number) ?? 1,
    deletedAt: chunk.cTime as Date,
    finalState: chunk.payload as Record<string, unknown>,
  }));
}

/**
 * Permanently deletes all chronicle data for a document.
 * This is an irreversible operation that removes all chunks, branches, and metadata.
 *
 * @param ctx - Chronicle context
 * @param docId - Document ID to purge
 * @param options - Purge options (must include confirm: true)
 * @returns Result containing counts of removed items
 */
export async function chroniclePurge(
  ctx: ChronicleContext,
  docId: Types.ObjectId,
  options: PurgeOptions
): Promise<PurgeResult> {
  // Safety check - require explicit confirmation
  if (options.confirm !== true) {
    throw new Error('Purge requires explicit confirmation. Set options.confirm = true to execute.');
  }

  const metadataCollectionName = ctx.options.metadataCollectionName ??
    `${ctx.baseCollectionName}_chronicle_metadata`;
  const branchCollectionName = `${ctx.baseCollectionName}_chronicle_branches`;
  const keysCollectionName = `${ctx.baseCollectionName}_chronicle_keys`;

  const metadataCollection = ctx.connection.db?.collection(metadataCollectionName);
  const branchCollection = ctx.connection.db?.collection(branchCollectionName);
  const chunksCollection = ctx.connection.db?.collection(ctx.chunksCollectionName);
  const keysCollection = ctx.connection.db?.collection(keysCollectionName);

  if (!metadataCollection || !branchCollection || !chunksCollection) {
    throw new Error('Chronicle collections not initialized');
  }

  // Build query - optionally filter by specific epoch
  const epochQuery: Record<string, unknown> = { docId };
  if (options.epoch !== undefined) {
    epochQuery.epoch = options.epoch;
  }

  // Get list of epochs being purged
  const metadataDocs = await metadataCollection.find(epochQuery).toArray();
  const epochsPurged = metadataDocs.map(m => (m.epoch as number) ?? 1);

  if (epochsPurged.length === 0) {
    throw new Error(`No chronicle data found for document ${docId}`);
  }

  // Delete chunks
  const chunkQuery: Record<string, unknown> = { docId };
  if (options.epoch !== undefined) {
    chunkQuery.epoch = options.epoch;
  }
  const chunkResult = await chunksCollection.deleteMany(chunkQuery);
  const chunksRemoved = chunkResult.deletedCount;

  // Delete branches
  const branchQuery: Record<string, unknown> = { docId };
  if (options.epoch !== undefined) {
    branchQuery.epoch = options.epoch;
  }
  const branchResult = await branchCollection.deleteMany(branchQuery);
  const branchesRemoved = branchResult.deletedCount;

  // Delete metadata
  await metadataCollection.deleteMany(epochQuery);

  // Delete keys entries if keys collection exists
  if (keysCollection) {
    await keysCollection.deleteMany({ docId });
  }

  return {
    success: true,
    docId,
    epochsPurged,
    chunksRemoved,
    branchesRemoved,
  };
}
