const mongoose = require('mongoose');
const logger = require('./logger');

const connectDB = async () => {
  try {
    const isTest = process.env.NODE_ENV === 'test';
    const mongoUri = isTest
      ? (process.env.MONGODB_URI_TEST || 'mongodb://mongo:27017/agentx_test')
      : (process.env.MONGODB_URI || 'mongodb://mongo:27017/agentx');

    const conn = await mongoose.connect(mongoUri, {
      serverSelectionTimeoutMS: isTest ? 1000 : 2000,
      maxPoolSize: isTest ? 5 : 20,
      minPoolSize: isTest ? 0 : 5,
      maxIdleTimeMS: 30000,
      socketTimeoutMS: 45000,
      family: 4,
      autoCreate: !isTest,
      autoIndex: !isTest
    });

    logger.info('MongoDB connected', {
      host: conn.connection.host,
      port: conn.connection.port,
      db: conn.connection.name
    });
  } catch (err) {
    logger.error('MongoDB connection failed', { error: err.message });
    throw err;
  }
};

module.exports = connectDB;
