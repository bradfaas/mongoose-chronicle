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
  name: { type: String, required: true },
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

### ChronicleChunk Storage

When you apply the chronicle plugin to a schema, documents are stored as "ChronicleChunks" rather than plain documents:

**Without mongoose-chronicle:**
```javascript
// Single document that gets overwritten on each update
{
  "_id": "507f1f77bcf86cd799439011",
  "sku": "WIDGET-001",
  "name": "Blue Widget",
  "price": 29.99
}
```

**With mongoose-chronicle:**
```javascript
// Initial creation - stored as a "full" chunk (ccType: 1)
{
  "_id": "507f1f77bcf86cd799439012",
  "docId": "507f1f77bcf86cd799439011",
  "branchId": "507f1f77bcf86cd799439013",
  "serial": 1,
  "ccType": 1,  // 1 = full
  "isDeleted": false,
  "cTime": "2025-01-15T10:00:00.000Z",
  "payload": {
    "sku": "WIDGET-001",
    "name": "Blue Widget",
    "price": 29.99
  }
}

// Subsequent update - stored as a "delta" chunk (ccType: 2)
{
  "_id": "507f1f77bcf86cd799439014",
  "docId": "507f1f77bcf86cd799439011",
  "branchId": "507f1f77bcf86cd799439013",
  "serial": 2,
  "ccType": 2,  // 2 = delta
  "isDeleted": false,
  "cTime": "2025-01-15T11:00:00.000Z",
  "payload": {
    "price": 24.99  // Only the changed field
  }
}
```

### Document Rehydration

When you query for a document, mongoose-chronicle automatically:

1. Finds the most recent "full" chunk for the document
2. Applies all subsequent "delta" chunks in order
3. Returns the fully rehydrated document

This process is transparent - your existing queries work unchanged.

## Configuration Options

```typescript
interface ChroniclePluginOptions {
  // Property to use as document identifier (default: '_id')
  primaryKey?: string;

  // Number of deltas before creating a new full chunk (default: 10)
  fullChunkInterval?: number;

  // Fields to index in the payload
  indexes?: string[];

  // Fields with unique constraints
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
  indexes: ['name', 'price'],  // Index these fields in payload
  uniqueKeys: ['sku'],         // Enforce uniqueness on these fields
  configCollectionName: 'my_chronicle_config',
  metadataCollectionName: 'products_metadata',
});
```

## API Reference

### Plugin Methods

Once the plugin is applied, your models gain additional methods:

#### Instance Methods

```typescript
// Get complete history of a document
const history = await product.getHistory();

// Create a named snapshot (branch) at current state
const snapshot = await product.createSnapshot('v1.0-release');

// List all branches for this document
const branches = await product.getBranches();
```

#### Static Methods

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

### Chronicle Collections

The plugin creates several supporting collections:

| Collection | Purpose |
|------------|---------|
| `chronicle_config` | Stores plugin configuration per collection |
| `{collection}_chronicle_metadata` | Tracks active branch and document state |
| `{collection}_chronicle_branches` | Stores branch information |

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

## Best Practices

1. **Choose fullChunkInterval wisely** - Lower values mean faster reads but more storage. Higher values save storage but slow down rehydration.

2. **Index strategically** - Only specify indexes for fields you frequently query on.

3. **Initialize once** - Call `initializeChronicle()` once during application startup, not on every request.

4. **Use branches for experiments** - Test changes on a branch before merging to main.

## License

MIT
