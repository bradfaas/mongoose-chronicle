"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ChronicleUniqueConstraintError = void 0;
exports.validateUniqueConstraints = validateUniqueConstraints;
exports.updateChronicleKeys = updateChronicleKeys;
exports.clearIsLatestFlag = clearIsLatestFlag;
exports.getOrCreateDocumentState = getOrCreateDocumentState;
exports.rehydrateDocument = rehydrateDocument;
exports.createChronicleChunk = createChronicleChunk;
exports.shouldWriteFullChunk = shouldWriteFullChunk;
exports.finalizeChronicleOperation = finalizeChronicleOperation;
exports.processChroniclesSave = processChroniclesSave;
const mongoose_1 = require("mongoose");
const delta_1 = require("../utils/delta");
/**
 * Error thrown when a unique constraint violation is detected
 */
class ChronicleUniqueConstraintError extends Error {
    field;
    value;
    constructor(field, value) {
        super(`Duplicate key error: ${field} "${value}" already exists`);
        this.name = 'ChronicleUniqueConstraintError';
        this.field = field;
        this.value = value;
    }
}
exports.ChronicleUniqueConstraintError = ChronicleUniqueConstraintError;
/**
 * Validates that unique fields don't conflict with existing documents
 * @param ctx - Chronicle context
 * @param payload - The document payload to validate
 * @param excludeDocId - DocId to exclude from check (for updates)
 * @param branchId - Branch to check uniqueness within
 */
async function validateUniqueConstraints(ctx, payload, branchId, excludeDocId) {
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
        const query = {
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
async function updateChronicleKeys(ctx, docId, branchId, payload, isDeleted = false) {
    if (ctx.uniqueFields.length === 0) {
        return;
    }
    const keysCollectionName = `${ctx.baseCollectionName}_chronicle_keys`;
    const keysCollection = ctx.connection.db?.collection(keysCollectionName);
    if (!keysCollection) {
        return;
    }
    // Build the key document
    const keyDoc = {
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
    await keysCollection.updateOne({ docId, branchId }, {
        $set: keyDoc,
        $setOnInsert: { createdAt: new Date() },
    }, { upsert: true });
}
/**
 * Marks previous chunks as not latest
 * @param ctx - Chronicle context
 * @param docId - Document ID
 * @param branchId - Branch ID
 */
async function clearIsLatestFlag(ctx, docId, branchId) {
    const chunksCollection = ctx.connection.db?.collection(ctx.chunksCollectionName);
    if (!chunksCollection) {
        return;
    }
    await chunksCollection.updateMany({ docId, branchId, isLatest: true }, { $set: { isLatest: false } });
}
/**
 * Gets or creates the chronicle metadata for a document
 * @param ctx - Chronicle context
 * @param docId - Document ID (or undefined for new documents)
 * @returns The document state including branch and serial info
 */
async function getOrCreateDocumentState(ctx, docId) {
    const metadataCollectionName = ctx.options.metadataCollectionName ??
        `${ctx.baseCollectionName}_chronicle_metadata`;
    const branchCollectionName = `${ctx.baseCollectionName}_chronicle_branches`;
    const metadataCollection = ctx.connection.db?.collection(metadataCollectionName);
    const branchCollection = ctx.connection.db?.collection(branchCollectionName);
    const chunksCollection = ctx.connection.db?.collection(ctx.chunksCollectionName);
    if (!metadataCollection || !branchCollection || !chunksCollection) {
        throw new Error('Chronicle collections not initialized');
    }
    // For new documents
    if (!docId) {
        const newDocId = new mongoose_1.Types.ObjectId();
        const newBranchId = new mongoose_1.Types.ObjectId();
        // Create the main branch
        await branchCollection.insertOne({
            _id: newBranchId,
            docId: newDocId,
            parentBranchId: null,
            parentSerial: null,
            name: 'main',
            createdAt: new Date(),
        });
        // Create metadata pointing to main branch
        await metadataCollection.insertOne({
            _id: new mongoose_1.Types.ObjectId(),
            docId: newDocId,
            activeBranchId: newBranchId,
            metadataStatus: 'pending',
            createdAt: new Date(),
            updatedAt: new Date(),
        });
        return {
            docId: newDocId,
            branchId: newBranchId,
            currentSerial: 0,
            isNew: true,
        };
    }
    // For existing documents
    const metadata = await metadataCollection.findOne({ docId });
    if (!metadata) {
        throw new Error(`Chronicle metadata not found for document ${docId}`);
    }
    // Get the latest chunk to find current serial
    const latestChunk = await chunksCollection.findOne({ docId, branchId: metadata.activeBranchId, isLatest: true }, { projection: { serial: 1, payload: 1 } });
    // If there's a latest chunk, we need to rehydrate to get full payload
    let previousPayload;
    if (latestChunk) {
        previousPayload = await rehydrateDocument(ctx, docId, metadata.activeBranchId);
    }
    return {
        docId,
        branchId: metadata.activeBranchId,
        currentSerial: latestChunk?.serial ?? 0,
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
async function rehydrateDocument(ctx, docId, branchId, asOf) {
    const chunksCollection = ctx.connection.db?.collection(ctx.chunksCollectionName);
    if (!chunksCollection) {
        return undefined;
    }
    // Build query for chunks
    const query = { docId, branchId };
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
    let result = { ...chunks[fullChunkIndex]?.payload };
    // Apply subsequent deltas
    for (let i = fullChunkIndex + 1; i < chunks.length; i++) {
        const chunk = chunks[i];
        if (chunk?.ccType === 2) { // DELTA
            const delta = chunk.payload;
            for (const [key, value] of Object.entries(delta)) {
                if (value === null) {
                    delete result[key];
                }
                else {
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
async function createChronicleChunk(ctx, state, payload, ccType, isDeleted = false) {
    const chunksCollection = ctx.connection.db?.collection(ctx.chunksCollectionName);
    if (!chunksCollection) {
        throw new Error('Chronicle collection not initialized');
    }
    const chunkId = new mongoose_1.Types.ObjectId();
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
function shouldWriteFullChunk(currentSerial, fullChunkInterval) {
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
async function finalizeChronicleOperation(ctx, docId) {
    const metadataCollectionName = ctx.options.metadataCollectionName ??
        `${ctx.baseCollectionName}_chronicle_metadata`;
    const metadataCollection = ctx.connection.db?.collection(metadataCollectionName);
    if (!metadataCollection) {
        return;
    }
    await metadataCollection.updateOne({ docId }, {
        $set: {
            metadataStatus: 'active',
            updatedAt: new Date(),
        },
    });
}
/**
 * Processes a document save operation for chronicle
 * @param ctx - Chronicle context
 * @param doc - The mongoose document being saved
 * @param isNew - Whether this is a new document
 */
async function processChroniclesSave(ctx, doc, isNew) {
    const payload = doc.toObject({ getters: false, virtuals: false });
    delete payload._id;
    delete payload.__v;
    // Get or create document state
    const state = await getOrCreateDocumentState(ctx, isNew ? undefined : doc._id);
    // Validate unique constraints
    await validateUniqueConstraints(ctx, payload, state.branchId, isNew ? undefined : state.docId);
    // Determine chunk type and payload
    const fullChunkInterval = ctx.options.fullChunkInterval ?? 10;
    let chunkPayload;
    let chunkType;
    if (shouldWriteFullChunk(state.currentSerial, fullChunkInterval)) {
        // Write full chunk
        chunkPayload = payload;
        chunkType = 1; // FULL
    }
    else {
        // Write delta chunk
        const delta = (0, delta_1.computeDelta)(state.previousPayload ?? {}, payload);
        if ((0, delta_1.isDeltaEmpty)(delta)) {
            // No changes, skip writing
            return { docId: state.docId, chunkId: new mongoose_1.Types.ObjectId() };
        }
        chunkPayload = delta;
        chunkType = 2; // DELTA
    }
    // Create the chunk
    const chunkId = await createChronicleChunk(ctx, state, chunkPayload, chunkType);
    // Update chronicle keys for unique fields
    await updateChronicleKeys(ctx, state.docId, state.branchId, payload);
    // Finalize the operation
    await finalizeChronicleOperation(ctx, state.docId);
    return { docId: state.docId, chunkId };
}
//# sourceMappingURL=chronicle-operations.js.map