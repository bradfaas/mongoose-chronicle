import { Schema } from 'mongoose';

/**
 * Information about a field's index configuration
 */
export interface FieldIndexInfo {
  /** Field path (e.g., 'sku' or 'address.city') */
  path: string;
  /** Whether this field has an index */
  indexed: boolean;
  /** Whether this field has a unique constraint */
  unique: boolean;
  /** Whether this field is required */
  required: boolean;
  /** Whether this is a sparse index */
  sparse: boolean;
}

/**
 * Compound index definition from schema.index() calls
 */
export interface CompoundIndexInfo {
  /** Fields in the index with sort direction */
  fields: Record<string, 1 | -1>;
  /** Index options */
  options: {
    unique?: boolean;
    sparse?: boolean;
    name?: string;
  };
}

/**
 * Result of analyzing a schema for index information
 */
export interface SchemaIndexAnalysis {
  /** Fields with single-field indexes */
  indexedFields: FieldIndexInfo[];
  /** Fields with unique constraints */
  uniqueFields: FieldIndexInfo[];
  /** Compound indexes defined on the schema */
  compoundIndexes: CompoundIndexInfo[];
}

/**
 * Analyzes a Mongoose schema to extract index and unique key information
 * @param schema - The Mongoose schema to analyze
 * @returns Analysis results with indexed and unique fields
 */
export function analyzeSchemaIndexes(schema: Schema): SchemaIndexAnalysis {
  const indexedFields: FieldIndexInfo[] = [];
  const uniqueFields: FieldIndexInfo[] = [];
  const compoundIndexes: CompoundIndexInfo[] = [];

  // Analyze each path in the schema
  schema.eachPath((path, schemaType) => {
    // Skip internal mongoose fields
    if (path === '_id' || path === '__v') {
      return;
    }

    const options = schemaType.options as Record<string, unknown>;

    const fieldInfo: FieldIndexInfo = {
      path,
      indexed: Boolean(options.index),
      unique: Boolean(options.unique),
      required: Boolean(options.required),
      sparse: Boolean(options.sparse),
    };

    if (fieldInfo.indexed || fieldInfo.unique) {
      indexedFields.push(fieldInfo);
    }

    if (fieldInfo.unique) {
      uniqueFields.push(fieldInfo);
    }
  });

  // Extract compound indexes from schema.indexes()
  const schemaIndexes = schema.indexes();
  for (const [indexSpec, indexOptions] of schemaIndexes) {
    // Skip single-field indexes (already captured above)
    const fieldCount = Object.keys(indexSpec).length;
    if (fieldCount > 1) {
      compoundIndexes.push({
        fields: indexSpec as Record<string, 1 | -1>,
        options: {
          unique: Boolean(indexOptions?.unique),
          sparse: Boolean(indexOptions?.sparse),
          name: indexOptions?.name as string | undefined,
        },
      });
    }
  }

  return {
    indexedFields,
    uniqueFields,
    compoundIndexes,
  };
}

/**
 * Creates a "clean" version of a schema with indexes and unique constraints removed
 * This is used for the payload field in ChronicleChunk
 * @param schema - The original schema
 * @returns A new schema without index/unique constraints
 */
export function createCleanPayloadSchema(schema: Schema): Schema {
  const cleanDefinition: Record<string, unknown> = {};

  schema.eachPath((path, schemaType) => {
    // Skip internal mongoose fields
    if (path === '_id' || path === '__v') {
      return;
    }

    // Clone the schema type options without index-related properties
    const originalOptions = schemaType.options as Record<string, unknown>;
    const cleanOptions: Record<string, unknown> = { ...originalOptions };

    // Remove index-related properties
    delete cleanOptions.index;
    delete cleanOptions.unique;
    delete cleanOptions.sparse;

    cleanDefinition[path] = cleanOptions;
  });

  return new Schema(cleanDefinition, { _id: false, versionKey: false });
}

/**
 * Generates the index definitions needed for the ChronicleChunk collection
 * @param analysis - The schema analysis result
 * @param collectionName - Name of the original collection (for naming)
 * @returns Array of index specifications to create
 */
export function generateChronicleIndexes(
  analysis: SchemaIndexAnalysis,
  _collectionName: string
): Array<{ spec: Record<string, 1 | -1>; options: Record<string, unknown> }> {
  const indexes: Array<{ spec: Record<string, 1 | -1>; options: Record<string, unknown> }> = [];

  // Core indexes for chronicle operations
  // 1. Primary lookup index: find chunks for a document on a branch
  indexes.push({
    spec: { docId: 1, branchId: 1, serial: -1 },
    options: { name: 'chronicle_lookup' },
  });

  // 2. Point-in-time query index
  indexes.push({
    spec: { branchId: 1, cTime: -1 },
    options: { name: 'chronicle_time' },
  });

  // 3. Latest chunk lookup (for efficient current state queries)
  indexes.push({
    spec: { docId: 1, branchId: 1, isLatest: 1 },
    options: {
      name: 'chronicle_latest',
      partialFilterExpression: { isLatest: true },
    },
  });

  // 4. Create query indexes for originally indexed fields (on payload)
  for (const field of analysis.indexedFields) {
    // Don't create unique indexes on payload - we handle uniqueness separately
    indexes.push({
      spec: { [`payload.${field.path}`]: 1, branchId: 1, isDeleted: 1, isLatest: 1 } as Record<string, 1 | -1>,
      options: {
        name: `chronicle_payload_${field.path}`,
        partialFilterExpression: { isLatest: true, isDeleted: false },
      },
    });
  }

  return indexes;
}
