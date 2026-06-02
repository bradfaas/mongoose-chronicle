import { Schema, Types } from 'mongoose';
/**
 * Creates the ChronicleChunk schema that wraps original documents
 * @param _payloadSchema - The original document schema to wrap (reserved for future use)
 */
export declare function createChronicleChunkSchema(_payloadSchema?: Schema): Schema;
/**
 * Schema for Chronicle Metadata documents
 * Tracks the active branch and state for each unique document
 */
export declare const ChronicleMetadataSchema: Schema<any, import("mongoose").Model<any, any, any, any, any, any>, {}, {}, {}, {}, {
    timestamps: true;
}, {
    _id: Types.ObjectId;
    docId: Types.ObjectId;
    epoch: number;
    activeBranchId: Types.ObjectId;
    metadataStatus: "pending" | "active" | "orphaned";
} & import("mongoose").DefaultTimestampProps, import("mongoose").Document<unknown, {}, import("mongoose").FlatRecord<{
    _id: Types.ObjectId;
    docId: Types.ObjectId;
    epoch: number;
    activeBranchId: Types.ObjectId;
    metadataStatus: "pending" | "active" | "orphaned";
} & import("mongoose").DefaultTimestampProps>, {}, import("mongoose").ResolveSchemaOptions<{
    timestamps: true;
}>> & import("mongoose").FlatRecord<{
    _id: Types.ObjectId;
    docId: Types.ObjectId;
    epoch: number;
    activeBranchId: Types.ObjectId;
    metadataStatus: "pending" | "active" | "orphaned";
} & import("mongoose").DefaultTimestampProps> & Required<{
    _id: Types.ObjectId;
}> & {
    __v: number;
}>;
/**
 * Schema for Chronicle Branch documents
 */
export declare const ChronicleBranchSchema: Schema<any, import("mongoose").Model<any, any, any, any, any, any>, {}, {}, {}, {}, {
    timestamps: {
        createdAt: true;
        updatedAt: false;
    };
}, {
    _id: Types.ObjectId;
    docId: Types.ObjectId;
    epoch: number;
    name: string;
    parentBranchId: Types.ObjectId;
    parentSerial: number;
    createdAt: NativeDate;
}, import("mongoose").Document<unknown, {}, import("mongoose").FlatRecord<{
    _id: Types.ObjectId;
    docId: Types.ObjectId;
    epoch: number;
    name: string;
    parentBranchId: Types.ObjectId;
    parentSerial: number;
    createdAt: NativeDate;
}>, {}, import("mongoose").ResolveSchemaOptions<{
    timestamps: {
        createdAt: true;
        updatedAt: false;
    };
}>> & import("mongoose").FlatRecord<{
    _id: Types.ObjectId;
    docId: Types.ObjectId;
    epoch: number;
    name: string;
    parentBranchId: Types.ObjectId;
    parentSerial: number;
    createdAt: NativeDate;
}> & Required<{
    _id: Types.ObjectId;
}> & {
    __v: number;
}>;
/**
 * Schema for Chronicle Configuration documents
 */
export declare const ChronicleConfigSchema: Schema<any, import("mongoose").Model<any, any, any, any, any, any>, {}, {}, {}, {}, {
    timestamps: true;
}, {
    _id: Types.ObjectId;
    collectionName: string;
    fullChunkInterval: number;
    pluginVersion: string;
    indexedFields: string[];
    uniqueFields: string[];
} & import("mongoose").DefaultTimestampProps, import("mongoose").Document<unknown, {}, import("mongoose").FlatRecord<{
    _id: Types.ObjectId;
    collectionName: string;
    fullChunkInterval: number;
    pluginVersion: string;
    indexedFields: string[];
    uniqueFields: string[];
} & import("mongoose").DefaultTimestampProps>, {}, import("mongoose").ResolveSchemaOptions<{
    timestamps: true;
}>> & import("mongoose").FlatRecord<{
    _id: Types.ObjectId;
    collectionName: string;
    fullChunkInterval: number;
    pluginVersion: string;
    indexedFields: string[];
    uniqueFields: string[];
} & import("mongoose").DefaultTimestampProps> & Required<{
    _id: Types.ObjectId;
}> & {
    __v: number;
}>;
/**
 * Schema for Chronicle Keys collection
 * Maintains current unique key values for fast uniqueness checks
 * One document per unique docId+branchId combination
 */
export declare function createChronicleKeysSchema(uniqueFields: string[]): Schema;
//# sourceMappingURL=schemas.d.ts.map