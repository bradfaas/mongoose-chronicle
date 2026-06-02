"use strict";
/**
 * mongoose-chronicle
 * A Mongoose plugin for granular document history, branching, and snapshot capabilities
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = exports.ChunkType = exports.generateChronicleIndexes = exports.createCleanPayloadSchema = exports.analyzeSchemaIndexes = exports.isDeltaEmpty = exports.applyDeltas = exports.applyDelta = exports.computeDelta = exports.ChronicleConfigSchema = exports.ChronicleBranchSchema = exports.ChronicleMetadataSchema = exports.createChronicleKeysSchema = exports.createChronicleChunkSchema = exports.initializeChronicle = exports.chroniclePlugin = void 0;
var plugin_1 = require("./core/plugin");
Object.defineProperty(exports, "chroniclePlugin", { enumerable: true, get: function () { return plugin_1.chroniclePlugin; } });
Object.defineProperty(exports, "initializeChronicle", { enumerable: true, get: function () { return plugin_1.initializeChronicle; } });
var schemas_1 = require("./core/schemas");
Object.defineProperty(exports, "createChronicleChunkSchema", { enumerable: true, get: function () { return schemas_1.createChronicleChunkSchema; } });
Object.defineProperty(exports, "createChronicleKeysSchema", { enumerable: true, get: function () { return schemas_1.createChronicleKeysSchema; } });
Object.defineProperty(exports, "ChronicleMetadataSchema", { enumerable: true, get: function () { return schemas_1.ChronicleMetadataSchema; } });
Object.defineProperty(exports, "ChronicleBranchSchema", { enumerable: true, get: function () { return schemas_1.ChronicleBranchSchema; } });
Object.defineProperty(exports, "ChronicleConfigSchema", { enumerable: true, get: function () { return schemas_1.ChronicleConfigSchema; } });
var delta_1 = require("./utils/delta");
Object.defineProperty(exports, "computeDelta", { enumerable: true, get: function () { return delta_1.computeDelta; } });
Object.defineProperty(exports, "applyDelta", { enumerable: true, get: function () { return delta_1.applyDelta; } });
Object.defineProperty(exports, "applyDeltas", { enumerable: true, get: function () { return delta_1.applyDeltas; } });
Object.defineProperty(exports, "isDeltaEmpty", { enumerable: true, get: function () { return delta_1.isDeltaEmpty; } });
var schema_analyzer_1 = require("./utils/schema-analyzer");
Object.defineProperty(exports, "analyzeSchemaIndexes", { enumerable: true, get: function () { return schema_analyzer_1.analyzeSchemaIndexes; } });
Object.defineProperty(exports, "createCleanPayloadSchema", { enumerable: true, get: function () { return schema_analyzer_1.createCleanPayloadSchema; } });
Object.defineProperty(exports, "generateChronicleIndexes", { enumerable: true, get: function () { return schema_analyzer_1.generateChronicleIndexes; } });
var types_1 = require("./types");
Object.defineProperty(exports, "ChunkType", { enumerable: true, get: function () { return types_1.ChunkType; } });
// Default export for convenient usage
var plugin_2 = require("./core/plugin");
Object.defineProperty(exports, "default", { enumerable: true, get: function () { return plugin_2.chroniclePlugin; } });
//# sourceMappingURL=index.js.map