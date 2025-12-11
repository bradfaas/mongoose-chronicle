# mongoose-chronicle

A Mongoose plugin that provides granular document history, branching, and snapshot capabilities for MongoDB documents.

## Features

- **Incremental Change History** - Every document change is preserved forever as a series of "chunks"
- **Delta Storage** - Only changed fields are stored for updates, reducing storage overhead
- **Point-in-Time Queries** - Retrieve any document's state at any moment in history
- **Branching** - Create branches from any point in a document's history (similar to git)
- **Snapshots** - Save named points-in-time for easy reference
- **Transparent Operation** - Existing Mongoose code works without modification
- **Soft Deletes** - Deleted documents can be recovered or viewed historically
- **Automatic Index Analysis** - Detects indexes and unique constraints from your schema
- **Unique Constraint Enforcement** - Validates unique fields across chronicle history

## Installation

```bash
npm install mongoose-chronicle
```

**Note:** Mongoose 7.0.0 or higher is required as a peer dependency.

## Quick Start

```typescript
import mongoose from 'mongoose';
import { chroniclePlugin, initializeChronicle } from 'mongoose-chronicle';

// Define your schema as usual
const ProductSchema = new mongoose.Schema({
  sku: { type: String, required: true, unique: true },
  name: { type: String, required: true, index: true },
  price: { type: Number, default: 0 },
});

// Apply the chronicle plugin
ProductSchema.plugin(chroniclePlugin, {
  fullChunkInterval: 10, // Create a full snapshot every 10 changes
});

// Create your model
const Product = mongoose.model('Product', ProductSchema);

// Initialize chronicle collections (call once at startup)
await initializeChronicle(mongoose.connection, 'products');
```

## How It Works

### Architecture Overview

When you apply the chronicle plugin to a schema, mongoose-chronicle:

1. **Intercepts save operations** via Mongoose middleware
2. **Creates ChronicleChunks** in a separate `{collection}_chronicle_chunks` collection
3. **Maintains metadata** to track document state and active branches
4. **Enforces unique constraints** via a dedicated `{collection}_chronicle_keys` collection
5. **Continues normal Mongoose save** for backward compatibility with existing queries

### Collection Structure

For a model with collection name `products`, the plugin creates:

| Collection | Purpose |
|------------|---------|
| `products` | Original documents (standard Mongoose behavior) |
| `products_chronicle_chunks` | Historical chunks (full and delta) |
| `products_chronicle_metadata` | Tracks active branch per document |
| `products_chronicle_branches` | Branch information |
| `products_chronicle_keys` | Current unique key values for constraint enforcement |
| `chronicle_config` | Plugin configuration per collection |

### ChronicleChunk Storage

Documents are stored as "ChronicleChunks" with full/delta compression:

**Initial creation - stored as a "full" chunk (ccType: 1):**
```javascript
{
  "_id": "507f1f77bcf86cd799439012",
  "docId": "507f1f77bcf86cd799439011",
  "branchId": "507f1f77bcf86cd799439013",
  "serial": 1,
  "ccType": 1,  // 1 = full
  "isDeleted": false,
  "isLatest": true,
  "cTime": "2025-01-15T10:00:00.000Z",
  "payload": {
    "sku": "WIDGET-001",
    "name": "Blue Widget",
    "price": 29.99
  }
}
```

**Subsequent update - stored as a "delta" chunk (ccType: 2):**
```javascript
{
  "_id": "507f1f77bcf86cd799439014",
  "docId": "507f1f77bcf86cd799439011",
  "branchId": "507f1f77bcf86cd799439013",
  "serial": 2,
  "ccType": 2,  // 2 = delta
  "isDeleted": false,
  "isLatest": true,  // Previous chunk's isLatest is set to false
  "cTime": "2025-01-15T11:00:00.000Z",
  "payload": {
    "price": 24.99  // Only the changed field
  }
}
```

### Document Rehydration

When you query for a document's history, mongoose-chronicle:

1. Finds the most recent "full" chunk for the document
2. Applies all subsequent "delta" chunks in order
3. Returns the fully rehydrated document state

### Automatic Index Detection

The plugin automatically analyzes your schema to detect:

- **Indexed fields** - Creates optimized payload indexes in chronicle collections
- **Unique fields** - Enforces uniqueness via the chronicle_keys collection
- **Compound indexes** - Preserves compound index information

```typescript
const ProductSchema = new mongoose.Schema({
  sku: { type: String, unique: true },      // Detected as unique
  name: { type: String, index: true },       // Detected as indexed
  category: { type: String },
});

// The plugin automatically detects sku as unique and name as indexed
ProductSchema.plugin(chroniclePlugin);
```

### Unique Constraint Handling

Since chronicle stores multiple versions of documents, traditional MongoDB unique indexes won't work correctly. The plugin uses a dedicated `chronicle_keys` collection to:

1. **Track current values** of unique fields per document/branch
2. **Validate before save** that no conflicts exist
3. **Support sparse uniqueness** (null/undefined values are allowed for multiple documents)

```typescript
// Unique constraint is enforced through chronicle_keys collection
const doc1 = new Product({ sku: 'SKU001', name: 'Widget' });
await doc1.save(); // Success

const doc2 = new Product({ sku: 'SKU001', name: 'Gadget' });
await doc2.save(); // Throws error: Duplicate key error: sku "SKU001" already exists
```

## Configuration Options

```typescript
interface ChroniclePluginOptions {
  // Property to use as document identifier (default: '_id')
  primaryKey?: string;

  // Number of deltas before creating a new full chunk (default: 10)
  fullChunkInterval?: number;

  // Fields to index in the payload (auto-detected from schema if not provided)
  indexes?: string[];

  // Fields with unique constraints (auto-detected from schema if not provided)
  uniqueKeys?: string[];

  // Name of the config collection (default: 'chronicle_config')
  configCollectionName?: string;

  // Name of the metadata collection (default: '{collection}_chronicle_metadata')
  metadataCollectionName?: string;
}
```

### Example with All Options

```typescript
ProductSchema.plugin(chroniclePlugin, {
  primaryKey: 'sku',           // Use 'sku' instead of '_id' as document identifier
  fullChunkInterval: 20,       // Create full snapshot every 20 changes
  indexes: ['name', 'price'],  // Override auto-detected indexes
  uniqueKeys: ['sku'],         // Override auto-detected unique keys
  configCollectionName: 'my_chronicle_config',
  metadataCollectionName: 'products_metadata',
});
```

## API Reference

### Plugin Functions

#### chroniclePlugin

The main plugin function to apply to your schema:

```typescript
import { chroniclePlugin } from 'mongoose-chronicle';

schema.plugin(chroniclePlugin, options);
```

#### initializeChronicle

Initialize chronicle collections and configuration. Call once at startup:

```typescript
import { initializeChronicle } from 'mongoose-chronicle';

await initializeChronicle(
  mongoose.connection,  // Mongoose connection
  'products',           // Collection name
  options               // Optional: same options as plugin
);
```

### Instance Methods

Once the plugin is applied, your documents gain additional methods:

```typescript
// Get complete history of a document
const history = await product.getHistory();

// Create a named snapshot (branch) at current state
const snapshot = await product.createSnapshot('v1.0-release');

// List all branches for this document
const branches = await product.getBranches();
```

### Static Methods

```typescript
// Find document state at a specific point in time
const pastState = await Product.findAsOf(
  { sku: 'WIDGET-001' },
  new Date('2025-01-01')
);

// Create a new branch from a document
const branch = await Product.createBranch(docId, 'experimental-pricing');

// Switch active branch for a document
await Product.switchBranch(docId, branchId);

// List all branches for a document
const branches = await Product.listBranches(docId);
```

### Utility Functions

```typescript
import {
  computeDelta,
  applyDelta,
  applyDeltas,
  isDeltaEmpty,
  analyzeSchemaIndexes,
  createCleanPayloadSchema,
  generateChronicleIndexes,
} from 'mongoose-chronicle';

// Compute difference between two objects
const delta = computeDelta(oldDoc, newDoc);

// Apply a delta to a base object
const result = applyDelta(baseDoc, delta);

// Apply multiple deltas sequentially
const finalState = applyDeltas(baseDoc, [delta1, delta2, delta3]);

// Check if a delta has any changes
if (!isDeltaEmpty(delta)) {
  // There are changes to save
}

// Analyze a schema for index information
const analysis = analyzeSchemaIndexes(schema);
console.log(analysis.indexedFields);  // Fields with index: true
console.log(analysis.uniqueFields);   // Fields with unique: true
console.log(analysis.compoundIndexes); // Compound indexes defined on schema
```

## Branching

Branching allows you to create alternate timelines for a document:

```typescript
// Create a branch for testing price changes
const testBranch = await Product.createBranch(productId, 'price-test');

// Switch to the test branch
await Product.switchBranch(productId, testBranch._id);

// Updates now go to the test branch
await Product.findByIdAndUpdate(productId, { price: 19.99 });

// Switch back to main branch - price is still 29.99
await Product.switchBranch(productId, mainBranchId);
```

## Schema Types

### ChronicleChunk

```typescript
interface ChronicleChunk<T> {
  _id: ObjectId;           // Unique chunk ID
  docId: ObjectId;         // Original document ID
  branchId: ObjectId;      // Branch this chunk belongs to
  serial: number;          // Sequential number within branch
  ccType: 1 | 2;           // 1 = full, 2 = delta
  isDeleted: boolean;      // Soft delete flag
  isLatest: boolean;       // True for the most recent chunk per doc/branch
  cTime: Date;             // Creation timestamp
  payload: Partial<T>;     // Document data or delta
}
```

### ChronicleMetadata

```typescript
interface ChronicleMetadata {
  _id: ObjectId;
  docId: ObjectId;                              // Document this metadata belongs to
  activeBranchId: ObjectId;                     // Currently active branch
  metadataStatus: 'pending' | 'active' | 'orphaned';
  createdAt: Date;
  updatedAt: Date;
}
```

### ChronicleBranch

```typescript
interface ChronicleBranch {
  _id: ObjectId;
  docId: ObjectId;                    // Document this branch belongs to
  parentBranchId: ObjectId | null;    // Parent branch (null for main)
  parentSerial: number | null;        // Serial in parent where branch was created
  name: string;                       // Human-readable branch name
  createdAt: Date;
}
```

### ChronicleKeys

```typescript
interface ChronicleKeys {
  _id: ObjectId;
  docId: ObjectId;           // Reference to the document
  branchId: ObjectId;        // Branch this key entry belongs to
  isDeleted: boolean;        // Whether the document is deleted
  key_fieldName: unknown;    // Dynamic fields for each unique key
  createdAt: Date;
  updatedAt: Date;
}
```

### ChronicleConfig

```typescript
interface ChronicleConfig {
  _id: ObjectId;
  collectionName: string;       // Collection this config applies to
  fullChunkInterval: number;    // Full chunk interval setting
  pluginVersion: string;        // Plugin version for migrations
  indexedFields: string[];      // Fields that are indexed
  uniqueFields: string[];       // Fields with unique constraints
  createdAt: Date;
  updatedAt: Date;
}
```

## Indexes

The plugin creates optimized indexes on chronicle collections:

### Core Chronicle Indexes

| Index Name | Fields | Purpose |
|------------|--------|---------|
| `chronicle_lookup` | `{ docId: 1, branchId: 1, serial: -1 }` | Fast chunk retrieval |
| `chronicle_time` | `{ branchId: 1, cTime: -1 }` | Point-in-time queries |
| `chronicle_latest` | `{ docId: 1, branchId: 1, isLatest: 1 }` | Current state queries (partial) |

### Payload Indexes

For each indexed field in your schema, the plugin creates:
- `chronicle_payload_{fieldName}` on `{ payload.{field}: 1, branchId: 1 }`
- Partial filter: `{ isLatest: true, isDeleted: false }`

### Keys Collection Indexes

- `chronicle_keys_doc_branch` - Unique index on `{ docId: 1, branchId: 1 }`
- `chronicle_keys_unique_{field}` - Unique index per unique field with partial filter

## Best Practices

1. **Choose fullChunkInterval wisely** - Lower values mean faster reads but more storage. Higher values save storage but slow down rehydration. Default of 10 is a good starting point.

2. **Let the plugin detect indexes** - Unless you have specific needs, let the plugin auto-detect indexes from your schema rather than manually specifying them.

3. **Initialize once** - Call `initializeChronicle()` once during application startup, not on every request.

4. **Use branches for experiments** - Test changes on a branch before merging to main.

5. **Consider unique constraints** - Be aware that unique constraints are enforced per-branch. A value can be unique within a branch but exist in multiple branches.

6. **Monitor collection sizes** - Chronicle collections grow over time. Plan for increased storage requirements.

## Current Limitations

The following features are planned but not yet fully implemented:

- `findAsOf()` - Point-in-time queries (TODO)
- `createBranch()` / `switchBranch()` - Branch management (TODO)
- `getHistory()` - Full document history retrieval (TODO)
- Query rewriting for `find()` / `findOne()` operations (TODO)
- `findOneAndUpdate` / `findOneAndDelete` middleware (TODO)

## Development

```bash
# Install dependencies
npm install

# Run tests
npm test

# Build
npm run build

# Lint
npm run lint
```

## License

MIT
