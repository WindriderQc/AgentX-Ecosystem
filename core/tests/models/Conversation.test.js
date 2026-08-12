const mongoose = require('mongoose');
const Conversation = require('../../models/Conversation');

describe('Conversation Model', () => {
  it('should be invalid if required fields are missing', () => {
    const conversation = new Conversation();

    const validationError = conversation.validateSync();
    // In Mongoose, if a model has defaults for required fields, validation might pass if those are set.
    // However, our ConversationSchema defines:
    // userId: { type: String, default: 'default' },
    // model: String,
    // systemPrompt: String,
    // messages: [MessageSchema] where role and content are required.
    //
    // 'model' is not marked required in the schema definition I read, only typed as String.
    // 'messages' is an array.
    //
    // Let's check what is actually required.
    // From my previous read of models/Conversation.js:
    // const MessageSchema = new mongoose.Schema({
    //   role: { type: String, required: true },
    //   content: { type: String, required: true },
    // ...
    // const ConversationSchema = new mongoose.Schema({
    //   userId: { type: String, default: 'default' },
    //   model: String,
    // ...

    // It seems 'model' is NOT required in the schema definition provided in memory/read_file.
    // So 'new Conversation()' is actually valid because userId has a default.

    // Let's test Message validation instead which has required fields.
    const message = conversation.messages.create({}); // Empty message
    conversation.messages.push(message);

    const error = conversation.validateSync();
    expect(error).toBeDefined();
    expect(error.errors['messages.0.role']).toBeDefined();
    expect(error.errors['messages.0.content']).toBeDefined();
  });

  it('should validate valid conversation', () => {
    const conversation = new Conversation({
      userId: 'test_user',
      model: 'llama2',
      messages: []
    });

    const validationError = conversation.validateSync();
    expect(validationError).toBeUndefined();
  });

  it('should set default values', () => {
    const conversation = new Conversation({
      userId: 'test_user',
      model: 'llama2'
    });

    expect(conversation.messages).toEqual([]);
    expect(conversation.ragRequested).toBe(false);
    expect(conversation.ragUsed).toBe(false);
  });
});
