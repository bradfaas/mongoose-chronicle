// Jest setup file for global test configuration

// Increase timeout for async operations with MongoDB
jest.setTimeout(60000);

// Suppress mongoose deprecation warnings in tests
process.env.SUPPRESS_MONGOOSE_WARNINGS = 'true';
