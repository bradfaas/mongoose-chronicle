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

// Create a new branch from a document (auto-activates by default)
const branch = await Product.createBranch(docId, 'experimental-pricing');

// Create a branch without activating it
const archiveBranch = await Product.createBranch(docId, 'archived-snapshot', { activate: false });

// Create a branch from a specific serial (point in history)
const branch = await Product.createBranch(docId, 'hotfix', { fromSerial: 5 });

// Switch active branch for a document
await Product.switchBranch(docId, branchId);

// List all branches for a document
const branches = await Product.listBranches(docId);

// Get the currently active branch for a document
const activeBranch = await Product.getActiveBranch(docId);

// Revert a branch to a specific serial (undo changes)
const revertResult = await Product.chronicleRevert(docId, 5);
// Returns: { success: true, revertedToSerial: 5, chunksRemoved: 3, state: {...} }

// Revert on a specific branch without rehydrating
await Product.chronicleRevert(docId, 3, { branchId: someBranchId, rehydrate: false });

// Get document state at a specific point in time
const historicalState = await Product.chronicleAsOf(docId, new Date('2024-06-15'));
// Returns: { found: true, state: {...}, serial: 5, branchId: '...', chunkTimestamp: Date }

// Query a specific branch at a point in time
const branchState = await Product.chronicleAsOf(docId, targetDate, { branchId: featureBranchId });

// Search across all branches for state at a timestamp
const crossBranchState = await Product.chronicleAsOf(docId, auditDate, { searchAllBranches: true });

// Preview what squash would delete (dry run)
const preview = await Product.chronicleSquash(docId, 5, { dryRun: true, confirm: false });
// Returns: { wouldDelete: { chunks: 47, branches: 5 }, newBaseState: {...} }

// Squash all history to a single point (destructive, irreversible)
const squashResult = await Product.chronicleSquash(docId, 5, { confirm: true });
// Returns: { success: true, previousChunkCount: 47, previousBranchCount: 5, newState: {...} }
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

Branching allows you to create alternate timelines for a document, similar to Git branches.

### Creating Branches

By default, `createBranch` automatically activates the new branch (like `git checkout -b`):

```typescript
// Create and switch to a new branch in one call
const featureBranch = await Product.createBranch(productId, 'feature-x');

// Subsequent saves automatically go to the new branch
product.price = 19.99;
await product.save(); // This change is recorded on 'feature-x', not 'main'
```

### Branch Options

```typescript
interface CreateBranchOptions {
  // Whether to activate the branch after creation (default: true)
  activate?: boolean;

  // Serial number to branch from (default: latest serial on active branch)
  fromSerial?: number;
}
```

### Common Use Cases

```typescript
// Create a branch for testing (auto-activates)
const testBranch = await Product.createBranch(productId, 'price-test');

// Create an archived snapshot without switching to it
const snapshot = await Product.createBranch(productId, 'v1.0-release', {
  activate: false
});

// Create a hotfix branch from a specific point in history
const hotfix = await Product.createBranch(productId, 'hotfix-123', {
  fromSerial: 5,   // Branch from serial 5
  activate: true   // And switch to it
});

// Check which branch is currently active
const active = await Product.getActiveBranch(productId);
console.log(active.name); // 'hotfix-123'

// List all branches for the document
const branches = await Product.listBranches(productId);
// Returns: [{ name: 'main', ... }, { name: 'price-test', ... }, ...]

// Switch back to main branch
const mainBranch = branches.find(b => b.name === 'main');
await Product.switchBranch(productId, mainBranch._id);
```

### Why Auto-Activate by Default?

The `activate: true` default was chosen because:

1. **Matches user expectations** - When you create a branch, you typically want to work on it
2. **Follows Git convention** - `git checkout -b` creates and switches in one command
3. **Reduces boilerplate** - Most callers won't need to make a second API call
4. **Prevents accidents** - No risk of commits going to the wrong branch

If you need to create a branch without switching to it (e.g., for bookmarks, archived snapshots, or preview branches), use `{ activate: false }`.

## History Management

mongoose-chronicle provides two operations for managing chronicle history: **Revert** (undo changes on a branch) and **Squash** (collapse all history to a single point).

### Revert (`chronicleRevert`)

Revert a branch's history to a specific serial, removing all chunks newer than the target. This only affects the specified branch - other branches remain untouched.

```typescript
// Revert active branch to serial 5
const result = await Product.chronicleRevert(productId, 5);
// result: {
//   success: true,
//   revertedToSerial: 5,
//   chunksRemoved: 3,
//   branchesUpdated: 1,  // Child branches whose parentSerial was updated
//   state: { /* rehydrated document state */ }
// }

// Revert a specific branch without rehydrating
await Product.chronicleRevert(productId, 3, {
  branchId: featureBranchId,
  rehydrate: false
});
```

**RevertOptions:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `branchId` | ObjectId | active branch | Target branch to revert |
| `rehydrate` | boolean | `true` | Return the document state after revert |

**Behavior:**
- Validates target serial exists on the branch
- Deletes all chunks with `serial > targetSerial`
- Marks target chunk as `isLatest: true`
- Updates orphaned child branches (sets their `parentSerial` to target if it was higher)
- Returns rehydrated state if `rehydrate: true`

### Squash (`chronicleSquash`)

Collapse ALL chronicle history into a single FULL chunk. This is a **destructive, irreversible** operation that removes all branches and history, creating a clean baseline.

```typescript
// Preview what would be deleted (dry run)
const preview = await Product.chronicleSquash(productId, 5, {
  dryRun: true,
  confirm: false
});
// preview: {
//   wouldDelete: { chunks: 47, branches: 5 },
//   newBaseState: { /* document state at serial 5 */ }
// }

// Execute squash (requires explicit confirmation)
const result = await Product.chronicleSquash(productId, 5, { confirm: true });
// result: {
//   success: true,
//   previousChunkCount: 47,
//   previousBranchCount: 5,
//   newState: { /* the new baseline state */ }
// }

// Squash to a state from a specific branch
await Product.chronicleSquash(productId, 3, {
  branchId: featureBranchId,
  confirm: true
});
```

**SquashOptions:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `confirm` | boolean | Yes | Must be `true` to execute (safety measure) |
| `branchId` | ObjectId | No | Which branch the target serial is on |
| `dryRun` | boolean | No | Preview without executing |

**Behavior:**
1. Rehydrates document state at the specified serial
2. Deletes ALL chunks across ALL branches
3. Deletes ALL branches
4. Creates new `main` branch with a single FULL chunk (serial: 1)
5. Updates metadata to point to the new main branch

### Comparison: Revert vs Squash

| Aspect | `chronicleRevert` | `chronicleSquash` |
|--------|-------------------|-------------------|
| **Scope** | Single branch | All branches |
| **Removes** | Newer chunks only | All chunks except new base |
| **Preserves** | Older history + other branches | Nothing |
| **Creates new chunk** | No | Yes (FULL at serial 1) |
| **Confirmation required** | No | Yes (`confirm: true`) |
| **Reversible** | Partially (deleted chunks are gone) | No |
| **Use case** | Undo recent changes | Clean slate / storage cleanup |

## Point-in-Time Queries (`chronicleAsOf`)

Query the state of a document at any arbitrary point in time. This is essential for auditing, debugging, compliance, and temporal data analysis.

### Basic Usage

```typescript
// Get document state as of yesterday
const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
const result = await Product.chronicleAsOf(productId, yesterday);

if (result.found) {
  console.log('State at', result.chunkTimestamp, ':', result.state);
  console.log('Was at serial', result.serial);
} else {
  console.log('No data exists for this document at that time');
}
```

### Query Options

```typescript
interface AsOfOptions {
  // Specific branch to query (default: active branch)
  branchId?: ObjectId;

  // Search across all branches for state at timestamp
  // Returns state from branch with most recent chunk at or before asOf
  // Mutually exclusive with branchId
  searchAllBranches?: boolean;
}
```

### Result Interface

```typescript
interface AsOfResult {
  // Whether a valid state was found
  found: boolean;

  // The rehydrated document state (undefined if found is false)
  state?: Record<string, unknown>;

  // Serial number of the chunk that was current at the timestamp
  serial?: number;

  // Branch ID from which the state was retrieved
  branchId?: ObjectId;

  // Exact timestamp of the chunk used (may be earlier than requested asOf)
  chunkTimestamp?: Date;
}
```

### Use Cases

**Audit & Compliance** - Retrieve exact state at audit points:
```typescript
const auditDate = new Date('2024-12-31T23:59:59Z');
const stateAtYearEnd = await Invoice.chronicleAsOf(invoiceId, auditDate);
```

**Debugging / Incident Response** - Investigate document state when issues occurred:
```typescript
const incidentTime = new Date('2024-03-15T14:32:00Z');
const stateAtIncident = await Order.chronicleAsOf(orderId, incidentTime);
```

**Historical Reporting** - Generate reports based on historical data:
```typescript
const reportDate = new Date('2024-06-30');
const products = await getProductIds();
const historicalStates = await Promise.all(
  products.map(id => Product.chronicleAsOf(id, reportDate))
);
```

**Diff Between Two Points in Time** - Compare document state:
```typescript
const before = await Product.chronicleAsOf(id, startDate);
const after = await Product.chronicleAsOf(id, endDate);
// Use your preferred diff library to compare before.state and after.state
```

### Specific Branch Query

```typescript
// Get state from a specific branch at a specific time
const result = await Product.chronicleAsOf(productId, targetDate, {
  branchId: featureBranchId
});
```

### Cross-Branch Search

When you need to find state across any branch at a given time:

```typescript
// Search all branches and return state from whichever had the most recent chunk
const result = await Product.chronicleAsOf(productId, auditDate, {
  searchAllBranches: true
});

if (result.found) {
  console.log('Found on branch:', result.branchId);
}
```

### Edge Cases

| Scenario | Behavior |
|----------|----------|
| No chunks exist before `asOf` | Returns `{ found: false }` |
| Document didn't exist at `asOf` | Returns `{ found: false }` |
| Branch didn't exist at `asOf` | Returns `{ found: false }` |
| `asOf` is in the future | Returns current/latest state |
| `asOf` exactly matches a chunk timestamp | Includes that chunk in rehydration |
| `branchId` and `searchAllBranches` both provided | Throws error (mutually exclusive) |

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

### CreateBranchOptions

```typescript
interface CreateBranchOptions {
  // Whether to activate the branch after creation (default: true)
  // When true, subsequent saves will be recorded on the new branch
  activate?: boolean;

  // Serial number to branch from (default: latest serial on active branch)
  // Allows creating branches from any point in history
  fromSerial?: number;
}
```

### RevertOptions

```typescript
interface RevertOptions {
  // Target branch to revert (default: active branch)
  branchId?: ObjectId;

  // If true, return the rehydrated document state (default: true)
  rehydrate?: boolean;
}
```

### RevertResult

```typescript
interface RevertResult {
  success: boolean;
  revertedToSerial: number;
  chunksRemoved: number;
  branchesUpdated: number;  // Branches whose parentSerial was updated
  state?: Record<string, unknown>;  // Rehydrated state if rehydrate: true
}
```

### SquashOptions

```typescript
interface SquashOptions {
  // Which branch the target serial is on (default: active branch)
  branchId?: ObjectId;

  // Safety flag - must be true to execute (required)
  confirm: boolean;

  // If true, preview without executing
  dryRun?: boolean;
}
```

### SquashResult

```typescript
interface SquashResult {
  success: boolean;
  previousChunkCount: number;
  previousBranchCount: number;
  newState: Record<string, unknown>;
}

interface SquashDryRunResult {
  wouldDelete: {
    chunks: number;
    branches: number;
  };
  newBaseState: Record<string, unknown>;
}
```

### AsOfOptions

```typescript
interface AsOfOptions {
  // Specific branch to query (default: active branch)
  branchId?: ObjectId;

  // Search all branches and return state from the one with most recent chunk
  // Mutually exclusive with branchId
  searchAllBranches?: boolean;
}
```

### AsOfResult

```typescript
interface AsOfResult {
  // Whether a valid state was found at the timestamp
  found: boolean;

  // The rehydrated document state (undefined if found is false)
  state?: Record<string, unknown>;

  // Serial number of the chunk current at the timestamp
  serial?: number;

  // Branch ID from which the state was retrieved
  branchId?: ObjectId;

  // Exact timestamp of the chunk used (may be earlier than asOf)
  chunkTimestamp?: Date;
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

7. **Use `chronicleSquash` sparingly** - Squash is destructive and irreversible. Always use `dryRun: true` first to preview what will be deleted. Consider using `chronicleRevert` instead if you only need to undo recent changes on a single branch.

8. **Revert preserves branch independence** - When you revert a branch past a child branch's creation point, the child branch remains intact (branches are self-contained with their own FULL chunks). Only the `parentSerial` metadata is updated.

## Current Limitations

The following features are planned but not yet fully implemented:

- `findAsOf()` - Multi-document point-in-time queries with filters (TODO)
- `getHistory()` - Full document history retrieval (TODO)
- Query rewriting for `find()` / `findOne()` operations (TODO)
- `findOneAndUpdate` / `findOneAndDelete` middleware (TODO)
- Branch merging (TODO)

**Note:** Single-document point-in-time queries are available via `chronicleAsOf()`.

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
